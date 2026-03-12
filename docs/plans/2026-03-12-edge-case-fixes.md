# Edge Case Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 43 cataloged edge cases across backend, frontend, audio, and multi-user flows, prioritized by severity.

**Architecture:** Extract server-side authorization and validation into a reusable `serverGuards.ts` utility. Unify voting state by lifting credits/votes into the server and syncing via socket. Debounce frontend emits. Add defensive checks throughout.

**Tech Stack:** TypeScript, Node.js test runner (`node:test`), Express, Socket.IO, React, Three.js/R3F, Mermaid

---

## Wave 1 — Security & Data Integrity (Critical)

### Task 1: Server-side authorization for `set_topic` and `set_phase`

**Files:**
- Modify: `server.ts:931-934` (set_topic handler)
- Modify: `server.ts:1045-1048` (set_phase handler)
- Create: `src/utils/serverGuards.ts`
- Create: `tests/server-guards.test.ts`

**Step 1: Write the failing tests**

In `tests/server-guards.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidPhase, isAdmin } from '../src/utils/serverGuards.ts';

test('isValidPhase accepts only the three valid phases', () => {
  assert.equal(isValidPhase('divergent'), true);
  assert.equal(isValidPhase('convergent'), true);
  assert.equal(isValidPhase('forging'), true);
  assert.equal(isValidPhase('invalid'), false);
  assert.equal(isValidPhase(''), false);
  assert.equal(isValidPhase(undefined), false);
  assert.equal(isValidPhase(123), false);
});

test('isAdmin checks participant role', () => {
  const adminParticipant = { socketId: 's1', userName: 'Admin', role: 'admin' as const, joinedAt: 0, contributionCount: 0, lastContributionAt: null };
  const regularParticipant = { socketId: 's2', userName: 'User', role: 'participant' as const, joinedAt: 0, contributionCount: 0, lastContributionAt: null };
  assert.equal(isAdmin(adminParticipant), true);
  assert.equal(isAdmin(regularParticipant), false);
  assert.equal(isAdmin(undefined), false);
  assert.equal(isAdmin(null), false);
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-transform-types --test tests/server-guards.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

In `src/utils/serverGuards.ts`:

```ts
export type SwarmPhase = 'divergent' | 'convergent' | 'forging';

const VALID_PHASES = new Set<string>(['divergent', 'convergent', 'forging']);

export function isValidPhase(phase: unknown): phase is SwarmPhase {
  return typeof phase === 'string' && VALID_PHASES.has(phase);
}

export interface ParticipantRecord {
  socketId: string;
  userName: string;
  role: 'admin' | 'participant';
  joinedAt: number;
  contributionCount: number;
  lastContributionAt: number | null;
}

export function isAdmin(participant: ParticipantRecord | null | undefined): boolean {
  return participant?.role === 'admin';
}
```

**Step 4: Run test to verify it passes**

Run: `node --experimental-transform-types --test tests/server-guards.test.ts`
Expected: PASS

**Step 5: Apply guards to server.ts**

In `server.ts`, add import:
```ts
import { isAdmin, isValidPhase } from './src/utils/serverGuards.ts';
```

Replace `set_topic` handler (lines 931-934):
```ts
socket.on("set_topic", (topic: string) => {
  if (!isAdmin(participants.get(socket.id))) return;
  if (typeof topic !== 'string' || !topic.trim()) return;
  state.topic = topic.trim();
  io.emit("topic_updated", state.topic);
});
```

Replace `set_phase` handler (lines 1045-1048):
```ts
socket.on("set_phase", (phase: string) => {
  if (!isAdmin(participants.get(socket.id))) return;
  if (!isValidPhase(phase)) return;
  state.phase = phase;
  io.emit("phase_changed", state.phase);
});
```

**Step 6: Run all tests**

Run: `node --experimental-transform-types --test tests/*.test.ts`
Expected: All PASS

**Step 7: Commit**

```bash
git add src/utils/serverGuards.ts tests/server-guards.test.ts server.ts
git commit -m "feat: add server-side authorization for set_topic and set_phase (B1, B2, M2)"
```

---

### Task 2: Server-side vote validation with per-socket credit tracking

**Files:**
- Modify: `src/utils/serverGuards.ts`
- Modify: `server.ts:972-988` (update_idea_weight handler)
- Modify: `server.ts:92-99` (participant record)
- Modify: `tests/server-guards.test.ts`

**Step 1: Write the failing tests**

Append to `tests/server-guards.test.ts`:

```ts
import { computeQuadraticCost, validateVote } from '../src/utils/serverGuards.ts';

test('computeQuadraticCost calculates cost difference correctly', () => {
  assert.equal(computeQuadraticCost(0, 1), 1);   // 1² - 0² = 1
  assert.equal(computeQuadraticCost(1, 2), 3);   // 4 - 1 = 3
  assert.equal(computeQuadraticCost(2, 3), 5);   // 9 - 4 = 5
  assert.equal(computeQuadraticCost(3, 2), -5);  // 4 - 9 = -5 (refund)
  assert.equal(computeQuadraticCost(1, 0), -1);  // 0 - 1 = -1 (refund)
});

test('validateVote rejects votes that exceed available credits', () => {
  const result = validateVote({ currentVotes: 0, credits: 0, delta: 1 });
  assert.equal(result.allowed, false);
});

test('validateVote accepts votes within budget', () => {
  const result = validateVote({ currentVotes: 0, credits: 100, delta: 1 });
  assert.equal(result.allowed, true);
  assert.equal(result.newVotes, 1);
  assert.equal(result.cost, 1);
});

test('validateVote rejects negative vote counts', () => {
  const result = validateVote({ currentVotes: 0, credits: 100, delta: -1 });
  assert.equal(result.allowed, false);
});

test('validateVote allows downvotes that refund credits', () => {
  const result = validateVote({ currentVotes: 3, credits: 10, delta: -1 });
  assert.equal(result.allowed, true);
  assert.equal(result.newVotes, 2);
  assert.equal(result.cost, -5); // refund
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-transform-types --test tests/server-guards.test.ts`
Expected: FAIL — functions not exported

**Step 3: Write implementation**

Add to `src/utils/serverGuards.ts`:

```ts
const INITIAL_CREDITS = 100;

export function computeQuadraticCost(currentVotes: number, newVotes: number): number {
  return (newVotes * newVotes) - (currentVotes * currentVotes);
}

export interface VoteValidation {
  currentVotes: number;
  credits: number;
  delta: number;
}

export interface VoteResult {
  allowed: boolean;
  newVotes: number;
  cost: number;
}

export function validateVote({ currentVotes, credits, delta }: VoteValidation): VoteResult {
  const newVotes = currentVotes + delta;
  if (newVotes < 0) return { allowed: false, newVotes: currentVotes, cost: 0 };
  const cost = computeQuadraticCost(currentVotes, newVotes);
  if (credits - cost < 0) return { allowed: false, newVotes: currentVotes, cost: 0 };
  return { allowed: true, newVotes, cost };
}

export { INITIAL_CREDITS };
```

**Step 4: Run test to verify it passes**

Run: `node --experimental-transform-types --test tests/server-guards.test.ts`
Expected: PASS

**Step 5: Add per-socket credits and votes to server state**

In `server.ts`, add to participant record type (around line 92):
```ts
credits: number;
votes: Record<string, number>; // ideaId -> vote count
```

In `upsertParticipant`, initialize:
```ts
credits: existing?.credits ?? INITIAL_CREDITS,
votes: existing?.votes ?? {},
```

Same in `markParticipantContribution`:
```ts
credits: existing?.credits ?? INITIAL_CREDITS,
votes: existing?.votes ?? {},
```

Import `INITIAL_CREDITS` and `validateVote` from serverGuards.

Replace `update_idea_weight` handler (lines 972-988):
```ts
socket.on("update_idea_weight", (data: { ideaId: string, weightChange: number }) => {
  const participant = participants.get(socket.id);
  if (!participant) return;
  const idea = state.ideas.find(i => i.id === data.ideaId);
  if (!idea) return;

  const currentVotes = participant.votes[data.ideaId] || 0;
  const result = validateVote({
    currentVotes,
    credits: participant.credits,
    delta: data.weightChange,
  });

  if (!result.allowed) return;

  participant.credits -= result.cost;
  participant.votes[data.ideaId] = result.newVotes;
  idea.weight = (idea.weight || 0) + data.weightChange;
  if (idea.weight < 0) idea.weight = 0;

  const existingUpdateIndex = pendingUpdates.findIndex(u => u.id === data.ideaId);
  if (existingUpdateIndex >= 0) {
    pendingUpdates[existingUpdateIndex] = idea;
  } else {
    pendingUpdates.push(idea);
  }

  socket.emit('credits_updated', { credits: participant.credits, votes: participant.votes });
  io.emit('idea_weight_updated', { ideaId: data.ideaId, weight: idea.weight });
});
```

**Step 6: Run all tests**

Run: `node --experimental-transform-types --test tests/*.test.ts`
Expected: All PASS

**Step 7: Commit**

```bash
git add src/utils/serverGuards.ts tests/server-guards.test.ts server.ts
git commit -m "feat: add server-side quadratic vote validation with per-socket credits (B4, M3, M8)"
```

---

### Task 3: Unify voting state — remove duplicate frontend credits

**Files:**
- Modify: `src/App.tsx:49-50, 165-183` (remove local credits/votes, use server state)
- Modify: `src/components/IdeaVoting.tsx:8-23` (remove local tokens/votes, accept from props)

**Step 1: Update App.tsx to receive credits from server**

Replace the local `credits`/`userVotes` state (lines 49-50) and the `handleVote` function (lines 165-183):

```tsx
const [credits, setCredits] = useState<number>(100);
const [userVotes, setUserVotes] = useState<Record<string, number>>({});
```

Add to socket event listeners (inside the `useEffect` at line 197):
```tsx
newSocket.on('credits_updated', ({ credits, votes }: { credits: number, votes: Record<string, number> }) => {
  setCredits(credits);
  setUserVotes(votes);
});
```

Simplify `handleVote` to just emit:
```tsx
const handleVote = (ideaId: string, change: number) => {
  socket?.emit('update_idea_weight', { ideaId, weightChange: change });
};
```

**Step 2: Update IdeaVoting to receive credits/votes as props**

Change `IdeaVoting` signature:
```tsx
export default function IdeaVoting({
  ideas,
  socket,
  credits,
  userVotes,
  onVote,
}: {
  ideas: any[];
  socket: Socket | null;
  credits: number;
  userVotes: Record<string, number>;
  onVote: (ideaId: string, delta: number) => void;
})
```

Remove internal `tokens`/`votes` state. Replace `handleVote` calls with `onVote`. Replace `tokens` with `credits`. Replace `votes[idea.id]` with `userVotes[idea.id]`.

**Step 3: Update IdeaVoting usage in App.tsx**

```tsx
<IdeaVoting
  ideas={ideas}
  socket={socket}
  credits={credits}
  userVotes={userVotes}
  onVote={handleVote}
/>
```

**Step 4: Manually test in browser**

Open the app, join as participant, vote on ideas — credits should decrement. Refresh — credits should reset to 100 server-side (fresh socket = fresh participant).

**Step 5: Commit**

```bash
git add src/App.tsx src/components/IdeaVoting.tsx
git commit -m "feat: unify voting state — server is single source of truth for credits (F1)"
```

---

## Wave 2 — Robustness (High)

### Task 4: Input validation on `add_idea` and `edit_idea`

**Files:**
- Modify: `src/utils/serverGuards.ts`
- Modify: `server.ts:937-959` (add_idea)
- Modify: `server.ts:991-1018` (edit_idea)
- Modify: `tests/server-guards.test.ts`

**Step 1: Write the failing tests**

```ts
import { sanitizeIdeaInput } from '../src/utils/serverGuards.ts';

test('sanitizeIdeaInput trims and truncates text', () => {
  assert.equal(sanitizeIdeaInput('  hello  ', 500).text, 'hello');
  assert.equal(sanitizeIdeaInput('a'.repeat(600), 500).text, 'a'.repeat(500));
});

test('sanitizeIdeaInput rejects empty text', () => {
  assert.equal(sanitizeIdeaInput('', 500).valid, false);
  assert.equal(sanitizeIdeaInput('   ', 500).valid, false);
});

test('sanitizeIdeaInput accepts valid text', () => {
  const result = sanitizeIdeaInput('Great idea', 500);
  assert.equal(result.valid, true);
  assert.equal(result.text, 'Great idea');
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-transform-types --test tests/server-guards.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Add to `src/utils/serverGuards.ts`:

```ts
export function sanitizeIdeaInput(text: unknown, maxLength = 500): { valid: boolean; text: string } {
  if (typeof text !== 'string') return { valid: false, text: '' };
  const trimmed = text.trim().slice(0, maxLength);
  return { valid: trimmed.length > 0, text: trimmed };
}
```

**Step 4: Run test to verify it passes**

Run: `node --experimental-transform-types --test tests/server-guards.test.ts`
Expected: PASS

**Step 5: Apply to server.ts**

In `add_idea` handler, add at the top:
```ts
const sanitized = sanitizeIdeaInput(idea.text);
if (!sanitized.valid) return;
```
Use `sanitized.text` instead of `idea.text`. Same for cluster:
```ts
const clusterSanitized = sanitizeIdeaInput(idea.cluster || 'General', 100);
```

In `edit_idea` handler, same pattern:
```ts
const sanitizedText = sanitizeIdeaInput(data.text);
if (!sanitizedText.valid) return;
const sanitizedCluster = sanitizeIdeaInput(data.cluster || 'General', 100);
```

**Step 6: Run all tests**

Run: `node --experimental-transform-types --test tests/*.test.ts`
Expected: All PASS

**Step 7: Commit**

```bash
git add src/utils/serverGuards.ts tests/server-guards.test.ts server.ts
git commit -m "feat: add input validation and length limits on add_idea and edit_idea (B3)"
```

---

### Task 5: Cap `state.ideas` array

**Files:**
- Modify: `server.ts` (wherever `state.ideas.push` is called)

**Step 1: Add constant and cap logic**

At the top of `startServer()`, add:
```ts
const MAX_IDEAS = 200;
```

Before every `state.ideas.push(newIdea)`, add a check:
```ts
if (state.ideas.length >= MAX_IDEAS) {
  // Remove the lowest-weight idea that isn't from the current push
  const minIndex = state.ideas.reduce((minIdx, idea, idx, arr) =>
    (idea.weight || 0) < (arr[minIdx].weight || 0) ? idx : minIdx, 0);
  state.ideas.splice(minIndex, 1);
}
```

There are 3 push sites: `add_idea` handler (~line 955), `extractIdea` tool call (~line 664), and devil's advocate (~line 536).

**Step 2: Manually verify**

Start the server, run simulation — ideas should never exceed 200.

**Step 3: Commit**

```bash
git add server.ts
git commit -m "feat: cap ideas array at 200 with lowest-weight eviction (B5)"
```

---

### Task 6: Debounce edit panel emits

**Files:**
- Modify: `src/App.tsx:185-194` (handleEditIdea)

**Step 1: Add debounce ref and modify handler**

Add near the other refs:
```tsx
const editDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

Replace `handleEditIdea`:
```tsx
const handleEditIdea = (id: string, text: string, cluster: string) => {
  // Update local state immediately for responsive UI
  setIdeas(prev => prev.map(i => i.id === id ? { ...i, text, cluster } : i));

  if (editDebounceRef.current) clearTimeout(editDebounceRef.current);
  editDebounceRef.current = setTimeout(() => {
    if (socket) {
      const idea = ideasRef.current.find(i => i.id === id);
      const textChanged = idea && idea.text !== text;
      socket.emit('edit_idea', { id, text, cluster, textChanged: !!textChanged });
    }
  }, 400);
};
```

**Step 2: Manually test**

Type quickly in the edit panel — network tab should show throttled emits instead of per-keystroke.

**Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat: debounce edit panel socket emits to 400ms (F6)"
```

---

### Task 7: Fix `isForging` stuck state

**Files:**
- Modify: `src/App.tsx:213-216` (error handler)

**Step 1: Add isForging reset to error handler**

In the socket `error` event listener (around line 213), add:
```tsx
newSocket.on('error', (err: any) => {
  console.error("Server error:", err);
  setAudioError(err.message || "Unknown server error");
  setIsForging(false); // Reset forging state on any error
});
```

Also add a dedicated handler for forge errors if the server sends the error to the requesting socket (which it does on line 1040):
```tsx
// The forge_artifact error is sent via socket.emit('error', ...) on line 1040 of server.ts
// So the general error handler above already covers it. Just ensure isForging resets.
```

**Step 2: Manually test**

Trigger forge with no ideas — should show error and re-enable button.

**Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "fix: reset isForging state on server error (F8)"
```

---

### Task 8: Fix `.sort()` mutation in IdeaVoting

**Files:**
- Modify: `src/components/IdeaVoting.tsx:43`

**Step 1: Fix the sort**

Change line 43 from:
```tsx
{ideas.sort((a, b) => b.weight - a.weight).map((idea) => {
```
to:
```tsx
{[...ideas].sort((a, b) => b.weight - a.weight).map((idea) => {
```

**Step 2: Commit**

```bash
git add src/components/IdeaVoting.tsx
git commit -m "fix: copy ideas array before sorting to prevent mutation (F2)"
```

---

### Task 9: Null-check `response.text` in researcher

**Files:**
- Modify: `server.ts:471`

**Step 1: Fix the null access**

Change line 471 from:
```ts
idea.urlTitle = firstChunk.web.title || response.text.substring(0, 30);
```
to:
```ts
idea.urlTitle = firstChunk.web.title || (response.text || '').substring(0, 30);
```

**Step 2: Commit**

```bash
git add server.ts
git commit -m "fix: null-check response.text in researcher to prevent crash (B11)"
```

---

### Task 10: Add timeouts to Gemini API calls

**Files:**
- Modify: `server.ts` (findUntouchedDirection, forgeArtifactFromTopic, synthesizer, devil's advocate)

**Step 1: Add a timeout utility**

Add near the top of `startServer()`:
```ts
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}
```

**Step 2: Wrap all Gemini calls**

In `findUntouchedDirection`, wrap the `generateContent` call:
```ts
const response = await withTimeout(
  getAI().models.generateContent({ ... }),
  15000,
  'findUntouchedDirection'
);
```

In `forgeArtifactFromTopic`:
```ts
const response = await withTimeout(
  getAI().models.generateContent({ ... }),
  20000,
  'forgeArtifactFromTopic'
);
```

In the synthesizer `setInterval`:
```ts
const response = await withTimeout(
  getAI().models.generateContent({ ... }),
  15000,
  'synthesizer'
);
```

In the devil's advocate `setInterval`:
```ts
const response = await withTimeout(
  getAI().models.generateContent({ ... }),
  15000,
  'devilsAdvocate'
);
```

**Step 3: Commit**

```bash
git add server.ts
git commit -m "feat: add 15-20s timeouts to all Gemini API calls (B13)"
```

---

### Task 11: Buffer early audio chunks until session is ready

**Files:**
- Modify: `server.ts:896-914` (audio_chunk handler)

**Step 1: Add a pending audio buffer**

Add per-socket variable near `audioChunkCount`:
```ts
let pendingAudioChunks: string[] = [];
```

Modify the `audio_chunk` handler:
```ts
socket.on("audio_chunk", (base64Data: string) => {
  audioChunkCount++;
  audioStreamStarted = true;
  clearPendingSessionClose();
  interruptAnchorAudio(io);
  if (audioChunkCount % 10 === 0) {
    logToFile(`Received 10 audio chunks from ${socket.id}`);
  }
  if (liveSessionPromise) {
    // Flush any buffered chunks first
    const buffered = pendingAudioChunks;
    pendingAudioChunks = [];
    liveSessionPromise.then(s => {
      for (const chunk of buffered) {
        s.sendRealtimeInput({ audio: { data: chunk, mimeType: 'audio/pcm;rate=16000' } });
      }
      s.sendRealtimeInput({ audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' } });
    }).catch(err => {
      console.error("Error sending audio chunk:", err);
      logToFile("Error sending audio chunk: " + err.message);
    });
  } else {
    // Buffer until session is ready (cap at 50 chunks ~= 3.2s)
    if (pendingAudioChunks.length < 50) {
      pendingAudioChunks.push(base64Data);
    }
  }
});
```

**Step 2: Commit**

```bash
git add server.ts
git commit -m "feat: buffer early audio chunks until live session connects (B15)"
```

---

### Task 12: Fix `Int16Array` alignment issue

**Files:**
- Modify: `src/App.tsx:106`

**Step 1: Fix the alignment**

Replace lines 105-109:
```tsx
const pcmBytes = evenByteLength === bytes.byteLength ? bytes : bytes.slice(0, evenByteLength);
const int16Array = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 2);
```

With:
```tsx
const pcmBytes = evenByteLength === bytes.byteLength ? bytes : bytes.slice(0, evenByteLength);
// Copy to an aligned buffer to avoid RangeError on browsers with strict alignment
const alignedBuffer = new ArrayBuffer(pcmBytes.byteLength);
new Uint8Array(alignedBuffer).set(pcmBytes);
const int16Array = new Int16Array(alignedBuffer);
```

**Step 2: Commit**

```bash
git add src/App.tsx
git commit -m "fix: ensure Int16Array uses aligned buffer for cross-browser compat (F11)"
```

---

### Task 13: Prevent participants from setting topic on join

**Files:**
- Modify: `src/App.tsx:529, 549` (role selection buttons)

**Step 1: Only emit set_topic for admin**

Change the admin button onClick (around line 526):
```tsx
onClick={() => {
  void ensurePlaybackAudioContext();
  setRole('admin');
  socket?.emit('set_topic', topic);
}}
```

Change the participant button onClick (around line 545) to NOT emit set_topic:
```tsx
onClick={() => {
  void ensurePlaybackAudioContext();
  setRole('participant');
  // Don't emit set_topic — participants should not override the admin's topic
}}
```

**Step 2: Commit**

```bash
git add src/App.tsx
git commit -m "fix: only admin sets topic on join, participants receive existing topic (F3)"
```

---

## Wave 3 — Performance & UX (Medium/Low)

### Task 14: Guard `setInterval` agents behind active-session check

**Files:**
- Modify: `server.ts:482-557` (synthesizer and devil's advocate intervals)

**Step 1: Add guards**

At the top of each `setInterval` callback, add:
```ts
if (!state.topic || participants.size === 0) return;
```

This prevents the synthesizer and devil's advocate from running when there's no active session.

**Step 2: Commit**

```bash
git add server.ts
git commit -m "feat: skip synthesizer and devil's advocate when no active session (B14)"
```

---

### Task 15: Cap `state.edges` and deduplicate

**Files:**
- Modify: `server.ts:494-500`

**Step 1: Add dedup and cap**

Replace the edge push logic in the synthesizer:
```ts
edges.forEach(e => {
  if (e.sourceId && e.targetId) {
    const exists = state.edges.some(
      existing => existing.source === e.sourceId && existing.target === e.targetId
    );
    if (!exists) {
      state.edges.push({ source: e.sourceId, target: e.targetId, reason: e.reason });
    }
  }
});
// Cap edges at 100
if (state.edges.length > 100) {
  state.edges = state.edges.slice(-100);
}
```

**Step 2: Commit**

```bash
git add server.ts
git commit -m "feat: deduplicate and cap edges array at 100 (B6)"
```

---

### Task 16: Cleanup audio/video resources on unmount

**Files:**
- Modify: `src/App.tsx:311-317` (useEffect cleanup)

**Step 1: Add full cleanup**

Replace the cleanup return:
```tsx
return () => {
  if (suggestionTimeoutRef.current) {
    window.clearTimeout(suggestionTimeoutRef.current);
  }
  if (mediaStreamRef.current) {
    mediaStreamRef.current.getTracks().forEach(t => t.stop());
  }
  if (videoStreamRef.current) {
    videoStreamRef.current.getTracks().forEach(t => t.stop());
  }
  if (videoIntervalRef.current) {
    window.clearInterval(videoIntervalRef.current);
  }
  if (workletNodeRef.current) {
    workletNodeRef.current.disconnect();
  }
  if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
    audioContextRef.current.close();
  }
  if (playbackAudioContextRef.current && playbackAudioContextRef.current.state !== 'closed') {
    playbackAudioContextRef.current.close();
  }
  newSocket.disconnect();
};
```

**Step 2: Commit**

```bash
git add src/App.tsx
git commit -m "fix: cleanup all audio/video resources on component unmount (F5, F9)"
```

---

### Task 17: Null audioContextRef after close

**Files:**
- Modify: `src/App.tsx:334-336, 306-308`

**Step 1: Set ref to null after closing**

After every `audioContextRef.current.close()`, add:
```tsx
audioContextRef.current = null;
```

There are two locations: the `toggleRecording` stop path (~line 334) and the `audio_session_closed` handler (~line 306).

**Step 2: Commit**

```bash
git add src/App.tsx
git commit -m "fix: null audioContextRef after close to prevent stale reference (F5)"
```

---

### Task 18: Mermaid security — switch to `strict` security level

**Files:**
- Modify: `src/components/ArtifactCanvas.tsx:32`

**Step 1: Change security level**

Change line 32 from:
```ts
securityLevel: 'loose',
```
to:
```ts
securityLevel: 'strict',
```

**Step 2: Manually verify**

Forge an artifact — diagram should still render. Scripts in SVG should be blocked.

**Step 3: Commit**

```bash
git add src/components/ArtifactCanvas.tsx
git commit -m "fix: switch Mermaid to strict security level to prevent XSS (F18)"
```

---

### Task 19: Unique Mermaid render IDs

**Files:**
- Modify: `src/components/ArtifactCanvas.tsx:54`

**Step 1: Add a counter for uniqueness**

Add a ref at the top of the component:
```tsx
const renderCountRef = useRef(0);
```

Change the render ID:
```tsx
renderCountRef.current += 1;
const id = `artifact-${renderCountRef.current}-${artifact.diagramType}`;
```

**Step 2: Commit**

```bash
git add src/components/ArtifactCanvas.tsx
git commit -m "fix: use unique Mermaid render IDs to prevent stale diagrams (F19)"
```

---

### Task 20: Singleton `getAI()`

**Files:**
- Modify: `server.ts:35-44`

**Step 1: Cache the client**

Replace the function:
```ts
let _aiClient: InstanceType<typeof GoogleGenAI> | null = null;
function getAI() {
  if (_aiClient) return _aiClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("No API key found in environment variables. Initializing without explicit key.");
    _aiClient = new GoogleGenAI({});
  } else {
    console.log("Initializing GoogleGenAI with API key of length:", apiKey.length);
    logToFile("Initializing GoogleGenAI with API key of length: " + apiKey.length);
    _aiClient = new GoogleGenAI({ apiKey });
  }
  return _aiClient;
}
```

**Step 2: Commit**

```bash
git add server.ts
git commit -m "refactor: cache GoogleGenAI client as singleton (B19)"
```

---

### Task 21: Run final full test suite

**Step 1: Run all tests**

Run: `node --experimental-transform-types --test tests/*.test.ts`
Expected: All PASS

**Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors (or only pre-existing ones)

**Step 3: Run dev server smoke test**

Run: `npm run dev`
Verify: Server starts, page loads, can join as admin, add ideas, vote, forge.
