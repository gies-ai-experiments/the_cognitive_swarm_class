import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import http from "http";
import { GoogleGenAI, Type, LiveServerMessage, Modality } from "@google/genai";
import fs from "fs";

function logToFile(msg: string) {
  fs.appendFileSync("server_debug.log", new Date().toISOString() + ": " + msg + "\n");
}

function getAI() {
  const apiKey = "AIzaSyAqX5a9lvo58lz_Ihh9fkKF95d8c6Ebpcg";
  if (!apiKey) {
    console.warn("No API key found in environment variables. Initializing without explicit key.");
    return new GoogleGenAI({});
  }
  console.log("Initializing GoogleGenAI with API key of length:", apiKey.length);
  logToFile("Initializing GoogleGenAI with API key of length: " + apiKey.length + ", starts with: " + apiKey.substring(0, 3));
  return new GoogleGenAI({ apiKey });
}

// Generate a fixed random projection matrix (3 x 768) to map embeddings to 3D space
const projectionMatrix = Array.from({ length: 3 }, () =>
  Array.from({ length: 3072 }, () => (Math.random() - 0.5) * 2)
);

function projectTo3D(embedding: number[]): [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < embedding.length; i++) {
    x += embedding[i] * projectionMatrix[0][i];
    y += embedding[i] * projectionMatrix[1][i];
    z += embedding[i] * projectionMatrix[2][i];
  }
  // Normalize and scale to fit visual space
  const mag = Math.sqrt(x * x + y * y + z * z);
  if (mag === 0) return [0, 0, 0];
  const scale = 12; // Spread radius
  return [(x / mag) * scale, (y / mag) * scale, (z / mag) * scale];
}

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  console.log("Server starting. GEMINI_API_KEY is", process.env.GEMINI_API_KEY ? "SET" : "NOT SET");
  logToFile("Server starting. GEMINI_API_KEY is " + (process.env.GEMINI_API_KEY ? "SET" : "NOT SET"));
  
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Global State for the Swarm
  let state = {
    topic: '',
    phase: 'divergent', // 'divergent' | 'convergent' | 'forging'
    ideas: [] as any[],
    edges: [] as any[],
    flowData: { nodes: [], edges: [] } as { nodes: any[], edges: any[] },
  };

  let pendingIdeas: any[] = [];
  let pendingUpdates: any[] = [];

  let lastIdeaTime = Date.now();

  function triggerResearcher(idea: any) {
    if (idea.authorId.startsWith('agent-')) return;
    
    getAI().models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Find a real-world article, data point, or example that validates or relates to this idea: "${idea.text}". Return a short 3-word summary of the finding.`,
      config: {
        tools: [{ googleSearch: {} }]
      }
    }).then(response => {
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
      if (chunks && chunks.length > 0) {
        const firstChunk = chunks.find(c => c.web?.uri);
        if (firstChunk && firstChunk.web) {
          idea.url = firstChunk.web.uri;
          idea.urlTitle = firstChunk.web.title || response.text.substring(0, 30);
          io.emit('idea_researched', { id: idea.id, url: idea.url, urlTitle: idea.urlTitle });
        }
      }
    }).catch(err => {
      console.error("Researcher error:", err);
      io.emit('error', { message: `Researcher error: ${err.message}` });
    });
  }

  // Catalyst Agent
  setInterval(async () => {
    if (state.ideas.length > 0 && Date.now() - lastIdeaTime > 60000) {
      console.log("Catalyst Agent triggered");
      try {
        const response = await getAI().models.generateContent({
          model: 'gemini-3.1-flash-lite-preview',
          contents: `The current brainstorming topic is: "${state.topic}".
          Here are the current ideas: ${JSON.stringify(state.ideas.map(i => i.text))}.
          The brainstorm has stalled. Generate ONE wild, tangential, or highly creative new idea to spark inspiration.
          Keep it to 3-7 words. Return JSON with 'idea' and 'category'.`,
          config: { responseMimeType: "application/json" }
        });
        const result = JSON.parse(response.text || "{}");
        if (result.idea && result.category) {
          const ideaId = Math.random().toString(36).substring(2, 9);
          const newIdea = {
            id: ideaId,
            text: result.idea,
            weight: 1,
            cluster: result.category,
            authorId: 'agent-catalyst',
            authorName: 'The Catalyst',
            initialPosition: [(Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20],
            targetPosition: null as any
          };
          state.ideas.push(newIdea);
          pendingIdeas.push(newIdea);
          lastIdeaTime = Date.now();

          getAI().models.embedContent({
            model: 'gemini-embedding-001',
            contents: result.idea,
          }).then(embRes => {
            const embedding = embRes.embeddings?.[0]?.values;
            if (embedding) {
              const targetPosition = projectTo3D(embedding);
              newIdea.targetPosition = targetPosition;
              io.emit('idea_positioned', { id: ideaId, targetPosition });
            }
          }).catch(err => console.error("Embedding error:", err));
        }
      } catch (e: any) {
        console.error("Catalyst error:", e);
        io.emit('error', { message: `Catalyst error: ${e.message}` });
      }
    }
  }, 10000);

  // Synthesizer Agent
  setInterval(async () => {
    if (state.ideas.length > 3) {
      console.log("Synthesizer Agent triggered");
      try {
        const response = await getAI().models.generateContent({
          model: 'gemini-3.1-flash-lite-preview',
          contents: `Here are the current ideas: ${JSON.stringify(state.ideas.map(i => ({id: i.id, text: i.text}))) }.
          Find 1-2 strong connections between existing ideas that aren't obvious.
          Return a JSON array of objects with 'sourceId', 'targetId', and 'reason'.`,
          config: { responseMimeType: "application/json" }
        });
        const edges = JSON.parse(response.text || "[]");
        if (Array.isArray(edges) && edges.length > 0) {
          edges.forEach(e => {
            if (e.sourceId && e.targetId) {
              state.edges.push({ source: e.sourceId, target: e.targetId, reason: e.reason });
            }
          });
          io.emit('edges_updated', state.edges);
        }
      } catch (e: any) {
        console.error("Synthesizer error:", e);
        io.emit('error', { message: `Synthesizer error: ${e.message}` });
      }
    }
  }, 45000);

  // Devil's Advocate Agent
  setInterval(async () => {
    if (state.ideas.length > 5) {
      console.log("Devil's Advocate Agent triggered");
      try {
        const response = await getAI().models.generateContent({
          model: 'gemini-3.1-flash-lite-preview',
          contents: `The current brainstorming topic is: "${state.topic}".
          Here are the current ideas: ${JSON.stringify(state.ideas.map(i => i.text))}.
          Act as a Devil's Advocate. Find a blind spot, contradiction, or critical flaw in the current ideas.
          Generate ONE challenging question or counter-argument. Keep it to 5-10 words.
          Return JSON with 'idea' and 'category' (use "Critique" as category).`,
          config: { responseMimeType: "application/json" }
        });
        const result = JSON.parse(response.text || "{}");
        if (result.idea) {
          const ideaId = Math.random().toString(36).substring(2, 9);
          const newIdea = {
            id: ideaId,
            text: result.idea,
            weight: 1.5,
            cluster: 'Critique',
            authorId: 'agent-critic',
            authorName: "Devil's Advocate",
            initialPosition: [(Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20],
            targetPosition: null as any
          };
          state.ideas.push(newIdea);
          pendingIdeas.push(newIdea);
          lastIdeaTime = Date.now();

          getAI().models.embedContent({
            model: 'gemini-embedding-001',
            contents: result.idea,
          }).then(embRes => {
            const embedding = embRes.embeddings?.[0]?.values;
            if (embedding) {
              const targetPosition = projectTo3D(embedding);
              newIdea.targetPosition = targetPosition;
              io.emit('idea_positioned', { id: ideaId, targetPosition });
            }
          }).catch(err => console.error("Embedding error:", err));
        }
      } catch (e: any) {
        console.error("Devil's Advocate error:", e);
        io.emit('error', { message: `Devil's Advocate error: ${e.message}` });
      }
    }
  }, 90000);

  // Batch broadcast every 1.5 seconds
  setInterval(() => {
    if (pendingIdeas.length > 0) {
      io.emit("ideas_batch_added", pendingIdeas);
      pendingIdeas = [];
    }
    if (pendingUpdates.length > 0) {
      // Deduplicate updates (keep the latest state for each idea ID)
      const uniqueUpdates = Array.from(new Map(pendingUpdates.map(item => [item.id, item])).values());
      io.emit("ideas_batch_updated", uniqueUpdates);
      pendingUpdates = [];
    }
  }, 1500);

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    
    // Send initial state
    socket.emit("state_sync", state);

    let liveSessionPromise: Promise<any> | null = null;
    let audioActive = false;
    let videoActive = false;
    let lastSpokenTime = Date.now();

    const suggestionInterval = setInterval(() => {
      if (audioActive && liveSessionPromise && state.ideas.length > 0) {
        // If no ideas added globally for 45s, and this agent hasn't spoken for 60s
        if (Date.now() - lastIdeaTime > 45000 && Date.now() - lastSpokenTime > 60000) {
          logToFile("Auto-suggesting direction for " + socket.id);
          lastSpokenTime = Date.now();
          liveSessionPromise.then(s => {
            s.send({
              clientContent: {
                turns: [{
                  role: "user",
                  parts: [{ text: "System Notification: The brainstorm has stalled. Please speak directly to the users and suggest a new, unexplored direction or perspective based on the current ideas." }]
                }],
                turnComplete: true
              }
            });
          }).catch(err => console.error("Error sending auto-suggestion:", err));
        }
      }
    }, 15000);

    const startSessionIfNeeded = (topic: string, userName: string) => {
      if (liveSessionPromise) return;
      
      const newSessionPromise = getAI().live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        callbacks: {
          onopen: () => {
            console.log("Gemini Live Connected for", socket.id);
            logToFile("Gemini Live Connected for " + socket.id);
            socket.emit("audio_session_started");
          },
          onmessage: async (message: LiveServerMessage) => {
            // console.log("Received message from Gemini:", Object.keys(message));
            if (message.serverContent?.modelTurn) {
              logToFile("Received modelTurn: " + JSON.stringify(message.serverContent.modelTurn).substring(0, 200));
              const parts = message.serverContent.modelTurn.parts;
              if (parts) {
                for (const part of parts) {
                  if (part.inlineData?.data) {
                    socket.emit("audio_response", part.inlineData.data);
                  }
                }
              }
            }
            if (message.serverContent?.interrupted) {
              logToFile("Received interrupted from Gemini");
              socket.emit("audio_interrupted");
            }

            // Handle tool calls
            if (message.toolCall) {
              logToFile("Received toolCall: " + JSON.stringify(message.toolCall));
              const calls = message.toolCall.functionCalls;
              if (calls) {
                const functionResponses: any[] = [];
                for (const call of calls) {
                  logToFile("Processing function call: " + call.name + " " + JSON.stringify(call.args));
                  if (call.name === 'extractIdea') {
                    const args = call.args as any;
                    const ideaId = Math.random().toString(36).substring(2, 9);
                    const newIdea = {
                      id: ideaId,
                      text: args.idea,
                      weight: 1,
                      cluster: args.category || 'General',
                      authorId: socket.id,
                      authorName: userName || 'Anonymous Node',
                      initialPosition: [(Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20],
                      targetPosition: null as any
                    };
                    state.ideas.push(newIdea);
                    pendingIdeas.push(newIdea);
                    lastIdeaTime = Date.now();
                    triggerResearcher(newIdea);

                    // Fetch embedding asynchronously
                    getAI().models.embedContent({
                      model: 'gemini-embedding-001',
                      contents: args.idea,
                    }).then(response => {
                      const embedding = response.embeddings?.[0]?.values;
                      if (embedding) {
                        const targetPosition = projectTo3D(embedding);
                        newIdea.targetPosition = targetPosition;
                        io.emit('idea_positioned', { id: ideaId, targetPosition });
                      }
                    }).catch(err => console.error("Embedding error:", err));

                    functionResponses.push({
                      id: call.id,
                      name: call.name,
                      response: { result: "Idea extracted successfully" }
                    });
                  } else if (call.name === 'generateMermaid') {
                    const args = call.args as any;
                    io.emit('update_mermaid', args.code);
                    functionResponses.push({
                      id: call.id,
                      name: call.name,
                      response: { result: "Mermaid diagram generated successfully" }
                    });
                  } else if (call.name === 'getIdeas') {
                    const ideasList = state.ideas.map(i => ({ text: i.text, cluster: i.cluster, weight: i.weight }));
                    functionResponses.push({
                      id: call.id,
                      name: call.name,
                      response: { ideas: ideasList }
                    });
                  }
                }

                if (liveSessionPromise) {
                  liveSessionPromise.then(s => s.sendToolResponse({ functionResponses })).catch(err => console.error("Error sending tool response:", err));
                }
              }
            }
          },
          onclose: (event) => {
            console.log("Gemini Live Disconnected for", socket.id, "Code:", event?.code, "Reason:", event?.reason);
            logToFile("Gemini Live Disconnected for " + socket.id + " Code: " + event?.code + " Reason: " + event?.reason);
            socket.emit("audio_session_closed");
            if (liveSessionPromise === newSessionPromise) {
              liveSessionPromise = null;
            }
          },
          onerror: (err: any) => {
            console.error("Gemini Live Error for", socket.id, err.message, err.error);
            logToFile("Gemini Live Error for " + socket.id + ": " + err.message + " - " + (err.error ? err.error.message : ""));
            socket.emit('error', { message: `Gemini Live Error: ${err.message || (err.error ? err.error.message : 'Unknown error')}` });
            if (liveSessionPromise === newSessionPromise) {
              liveSessionPromise = null;
            }
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } }
          },
          systemInstruction: `You are the Supervisor of 'The Cognitive Swarm'.
          Topic: "${topic}". User: ${userName}.
          Listen to the user, extract concise ideas, and use the 'extractIdea' tool to add them.
          Keep verbal responses extremely short (e.g., "Idea logged.").
          If asked to summarize or diagram, use 'getIdeas' then 'generateMermaid'.
          IMPORTANT: You MUST use 'extractIdea' whenever the user shares a new idea.`,
          tools: [{
            functionDeclarations: [
              {
                name: 'extractIdea',
                description: 'Extracts a brainstorming idea from the user audio.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    idea: { type: Type.STRING, description: 'A concise, 3-7 word summary of the idea.' },
                    category: { type: Type.STRING, description: 'A 1-2 word category or cluster name.' }
                  },
                  required: ['idea', 'category']
                }
              },
              {
                name: 'generateMermaid',
                description: 'Generates a Mermaid.js diagram based on the current ideas.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    code: { type: Type.STRING, description: 'The raw Mermaid.js code (e.g., graph TD; A-->B;)' }
                  },
                  required: ['code']
                }
              },
              {
                name: 'getIdeas',
                description: 'Gets the current list of brainstormed ideas and their weights.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    format: { type: Type.STRING, description: 'The format to return (e.g., "json")' }
                  }
                }
              }
            ]
          }]
        }
      });
      
      liveSessionPromise = newSessionPromise;
      
      liveSessionPromise.catch(err => {
        console.error("Live session connect error:", err);
        logToFile("Live session connect error: " + err.message);
        socket.emit('error', { message: `Live session connect error: ${err.message}` });
        if (liveSessionPromise === newSessionPromise) {
          liveSessionPromise = null;
        }
      });
    };

    const stopSessionIfNeeded = () => {
      if (!audioActive && !videoActive && liveSessionPromise) {
        liveSessionPromise.then(s => s.close()).catch(err => console.error(err));
        liveSessionPromise = null;
      }
    };

    socket.on("start_audio_session", (data: { topic: string, userName: string }) => {
      logToFile("start_audio_session received for " + socket.id);
      audioActive = true;
      startSessionIfNeeded(data.topic, data.userName);
    });

    socket.on("stop_audio_session", () => {
      logToFile("stop_audio_session received for " + socket.id);
      audioActive = false;
      stopSessionIfNeeded();
    });

    socket.on("suggest_direction", () => {
      logToFile("suggest_direction received for " + socket.id);
      lastSpokenTime = Date.now();
      if (liveSessionPromise) {
        liveSessionPromise.then(s => {
          s.send({
            clientContent: {
              turns: [{
                role: "user",
                parts: [{ text: "System Notification: The users are asking for a suggestion on a new, unexplored direction for the brainstorm based on the current ideas. Please speak directly to them and suggest one." }]
              }],
              turnComplete: true
            }
          });
        }).catch(err => console.error("Error sending suggest_direction:", err));
      }
    });

    socket.on("start_video_session", (data: { topic: string, userName: string }) => {
      videoActive = true;
      startSessionIfNeeded(data.topic, data.userName);
    });

    socket.on("stop_video_session", () => {
      videoActive = false;
      stopSessionIfNeeded();
    });

    let audioChunkCount = 0;
    socket.on("text_chunk", (text: string) => {
      logToFile(`Received text chunk: ${text}`);
      if (liveSessionPromise) {
        liveSessionPromise.then(s => {
          s.sendClientContent({
            turns: [{ role: 'user', parts: [{ text }] }],
            turnComplete: true
          });
        }).catch(err => {
          console.error("Error sending text chunk:", err);
          logToFile("Error sending text chunk: " + err.message);
        });
      }
    });

    socket.on("audio_chunk", (base64Data: string) => {
      audioChunkCount++;
      if (audioChunkCount % 10 === 0) {
        logToFile(`Received 10 audio chunks from ${socket.id}`);
      }
      if (liveSessionPromise) {
        liveSessionPromise.then(s => {
          s.sendRealtimeInput({
            media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
          });
        }).catch(err => {
          console.error("Error sending audio chunk:", err);
          logToFile("Error sending audio chunk: " + err.message);
        });
      }
    });

    socket.on("video_chunk", (base64Data: string) => {
      if (liveSessionPromise) {
        liveSessionPromise.then(s => {
          s.sendRealtimeInput({
            media: { data: base64Data, mimeType: 'image/jpeg' }
          });
        }).catch(err => {
          console.error("Error sending video chunk:", err);
          logToFile("Error sending video chunk: " + err.message);
        });
      }
    });

    // Update topic
    socket.on("set_topic", (topic: string) => {
      state.topic = topic;
      io.emit("topic_updated", state.topic);
    });

    // Ingestion Task: Receive new ideas from clients (extracted via Gemini)
    socket.on("add_idea", (idea: { id?: string, text: string, cluster: string, authorName?: string }) => {
      const initialPosition = [
        (Math.random() - 0.5) * 20,
        (Math.random() - 0.5) * 20,
        (Math.random() - 0.5) * 20
      ];

      const newIdea = {
        id: idea.id || Math.random().toString(36).substring(2, 9),
        text: idea.text,
        weight: 1, // Initial weight
        cluster: idea.cluster || 'General',
        authorId: socket.id,
        authorName: idea.authorName || 'Anonymous Node',
        initialPosition,
        targetPosition: null // Will be updated after embedding
      };
      
      state.ideas.push(newIdea);
      pendingIdeas.push(newIdea);
      lastIdeaTime = Date.now();
      triggerResearcher(newIdea);
    });

    // Update idea embedding
    socket.on("update_idea_embedding", (data: { id: string, embedding: number[] }) => {
      const existingIdea = state.ideas.find(i => i.id === data.id);
      if (existingIdea) {
        const targetPosition = projectTo3D(data.embedding);
        existingIdea.targetPosition = targetPosition;
        io.emit('idea_positioned', { id: existingIdea.id, targetPosition });
      }
    });

    // Consensus Mediator Task: Idea Voting
    socket.on("update_idea_weight", (data: { ideaId: string, weightChange: number }) => {
      const idea = state.ideas.find(i => i.id === data.ideaId);
      if (idea) {
        idea.weight = (idea.weight || 0) + data.weightChange;
        // Prevent negative weights
        if (idea.weight < 0) idea.weight = 0;
        
        const existingUpdateIndex = pendingUpdates.findIndex(u => u.id === data.ideaId);
        if (existingUpdateIndex >= 0) {
          pendingUpdates[existingUpdateIndex] = idea;
        } else {
          pendingUpdates.push(idea);
        }
        
        io.emit('idea_weight_updated', { ideaId: data.ideaId, weight: idea.weight });
      }
    });

    // Edit Idea Task
    socket.on("edit_idea", (data: { id: string, text: string, cluster: string, textChanged?: boolean }) => {
      const idea = state.ideas.find(i => i.id === data.id);
      if (idea) {
        idea.text = data.text;
        idea.cluster = data.cluster;
        
        if (data.textChanged) {
          getAI().models.embedContent({
            model: 'gemini-embedding-001',
            contents: data.text,
          }).then(response => {
            const embedding = response.embeddings?.[0]?.values;
            if (embedding) {
              const targetPosition = projectTo3D(embedding);
              idea.targetPosition = targetPosition;
              io.emit('idea_positioned', { id: idea.id, targetPosition });
            }
          }).catch(err => console.error("Embedding error:", err));
        }
        
        const existingUpdateIndex = pendingUpdates.findIndex(u => u.id === data.id);
        if (existingUpdateIndex >= 0) {
          pendingUpdates[existingUpdateIndex] = idea;
        } else {
          pendingUpdates.push(idea);
        }
      }
    });

    // Visual Scribe Task: Update React Flow Diagram
    socket.on("update_flow", (data: { nodes: any[], edges: any[] }) => {
      state.flowData = data;
      io.emit("flow_updated", state.flowData);
    });

    // Phase transition
    socket.on("set_phase", (phase: string) => {
      state.phase = phase;
      io.emit("phase_changed", state.phase);
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
      clearInterval(suggestionInterval);
      stopSessionIfNeeded();
    });
  });

  // API routes FIRST
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
