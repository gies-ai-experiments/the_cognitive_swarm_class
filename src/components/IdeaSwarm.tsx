import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls, PerspectiveCamera, Stars } from '@react-three/drei';
import * as THREE from 'three';

const CLUSTER_COLORS = [
  '#22c55e',
  '#38bdf8',
  '#f59e0b',
  '#f472b6',
  '#a78bfa',
  '#fb7185',
  '#2dd4bf',
  '#fde047',
  '#60a5fa',
  '#f97316',
];

function getClusterColor(cluster: string) {
  let hash = 0;
  for (let i = 0; i < cluster.length; i++) {
    hash = (hash * 31 + cluster.charCodeAt(i)) >>> 0;
  }
  return CLUSTER_COLORS[hash % CLUSTER_COLORS.length];
}

function fallbackPosition(index: number) {
  const angle = index * 0.82;
  const radius = 6 + (index % 7) * 0.9;
  const layer = ((index % 5) - 2) * 2.4;
  return [
    Math.cos(angle) * radius,
    Math.sin(angle * 1.2) * (radius * 0.55),
    layer,
  ] as [number, number, number];
}

function buildGraph(ideas: any[], edges: any[]) {
  const nodes = ideas.map((idea, index) => {
    const rawPosition = idea.targetPosition || idea.initialPosition || fallbackPosition(index);
    const position: [number, number, number] = [
      rawPosition[0] * 1.35,
      rawPosition[1] * 1.35,
      rawPosition[2] * 1.35,
    ];

    return {
      ...idea,
      position,
      color: getClusterColor(idea.cluster || 'General'),
      radius: 0.45 + Math.min(idea.weight || 1, 8) * 0.08,
    };
  });

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const links: Array<{
    key: string;
    source: string;
    target: string;
    isCluster: boolean;
    reason?: string;
  }> = [];

  const clusterGroups = new Map<string, any[]>();
  for (const node of nodes) {
    const cluster = node.cluster || 'General';
    const current = clusterGroups.get(cluster) || [];
    current.push(node);
    clusterGroups.set(cluster, current);
  }

  for (const clusterNodes of clusterGroups.values()) {
    for (let i = 1; i < clusterNodes.length; i++) {
      links.push({
        key: `cluster-${clusterNodes[i - 1].id}-${clusterNodes[i].id}`,
        source: clusterNodes[i - 1].id,
        target: clusterNodes[i].id,
        isCluster: true,
      });
    }
  }

  for (const edge of edges) {
    if (nodeMap.has(edge.source) && nodeMap.has(edge.target)) {
      links.push({
        key: `edge-${edge.source}-${edge.target}-${edge.reason || ''}`,
        source: edge.source,
        target: edge.target,
        isCluster: false,
        reason: edge.reason,
      });
    }
  }

  return { nodes, links, nodeMap };
}

/** Pulsing glow ring around selected/hovered nodes */
function GlowRing({ color, radius, active }: { color: string; radius: number; active: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const pulse = active ? 1 + Math.sin(clock.elapsedTime * 3) * 0.12 : 1;
    ref.current.scale.setScalar(pulse);
    (ref.current.material as THREE.MeshBasicMaterial).opacity = active ? 0.18 + Math.sin(clock.elapsedTime * 2) * 0.06 : 0;
  });

  return (
    <mesh ref={ref}>
      <ringGeometry args={[radius * 1.6, radius * 2.0, 32]} />
      <meshBasicMaterial color={color} transparent opacity={0} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** Floating particle ring around each node */
function OrbitalParticles({ color, radius }: { color: string; radius: number }) {
  const ref = useRef<THREE.Points>(null);
  const count = 8;

  const positions = useMemo(() => {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const r = radius * 2.2;
      pos[i * 3] = Math.cos(angle) * r;
      pos[i * 3 + 1] = Math.sin(angle) * r;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
    }
    return pos;
  }, [radius, count]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.rotation.z = clock.elapsedTime * 0.3;
    ref.current.rotation.x = Math.sin(clock.elapsedTime * 0.15) * 0.2;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color={color} size={0.06} transparent opacity={0.5} sizeAttenuation />
    </points>
  );
}

function SwarmNode({
  node,
  isSelected,
  onSelect,
}: {
  node: any;
  isSelected: boolean;
  onSelect?: (idea: any) => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const groupRef = useRef<THREE.Group>(null);

  // Gentle floating animation
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.elapsedTime;
    const hash = node.id.charCodeAt(0) * 0.1;
    groupRef.current.position.y = node.position[1] + Math.sin(t * 0.6 + hash) * 0.15;
  });

  const showLabel = isSelected || isHovered;
  const weight = node.weight || 1;

  return (
    <group
      ref={groupRef}
      position={node.position}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(node);
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        setIsHovered(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setIsHovered(false);
        document.body.style.cursor = 'default';
      }}
    >
      {/* Core sphere */}
      <mesh>
        <sphereGeometry args={[node.radius * (isHovered ? 1.15 : 1), 32, 32]} />
        <meshStandardMaterial
          color={node.color}
          emissive={node.color}
          emissiveIntensity={isSelected ? 1.0 : isHovered ? 0.7 : 0.45}
          metalness={0.35}
          roughness={0.2}
          transparent
          opacity={0.95}
        />
      </mesh>

      {/* Inner glow */}
      <mesh>
        <sphereGeometry args={[node.radius * 1.4, 20, 20]} />
        <meshBasicMaterial color={node.color} transparent opacity={isSelected ? 0.15 : isHovered ? 0.1 : 0.04} />
      </mesh>

      {/* Outer ambient glow */}
      <mesh>
        <sphereGeometry args={[node.radius * 2.2, 16, 16]} />
        <meshBasicMaterial color={node.color} transparent opacity={isSelected ? 0.06 : 0.02} />
      </mesh>

      {/* Pulse ring for selected/hovered */}
      <GlowRing color={node.color} radius={node.radius} active={isSelected || isHovered} />

      {/* Orbital particles */}
      {(isSelected || isHovered) && (
        <OrbitalParticles color={node.color} radius={node.radius} />
      )}

      {/* Label */}
      <Html position={[0, node.radius + 1.1, 0]} center distanceFactor={10} sprite>
        <div
          className="pointer-events-none select-none transition-all duration-200"
          style={{
            opacity: showLabel ? 1 : 0.75,
            transform: showLabel ? 'scale(1)' : 'scale(0.88)',
          }}
        >
          <div
            className="relative rounded-xl border px-3.5 py-2.5 text-center shadow-2xl backdrop-blur-xl"
            style={{
              maxWidth: showLabel ? '260px' : '180px',
              borderColor: showLabel ? `${node.color}40` : 'rgba(255,255,255,0.08)',
              backgroundColor: showLabel ? 'rgba(0,0,0,0.92)' : 'rgba(0,0,0,0.65)',
              boxShadow: showLabel ? `0 0 24px ${node.color}20, 0 8px 32px rgba(0,0,0,0.5)` : 'none',
            }}
          >
            {/* Weight badge */}
            {weight > 1 && (
              <div
                className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold"
                style={{
                  backgroundColor: node.color,
                  color: '#000',
                  boxShadow: `0 0 8px ${node.color}60`,
                }}
              >
                {weight}
              </div>
            )}

            {/* Idea text */}
            <div
              className="leading-snug font-medium"
              style={{
                fontSize: showLabel ? '13px' : '11px',
                color: showLabel ? '#fff' : 'rgba(255,255,255,0.8)',
              }}
            >
              {showLabel ? node.text : (node.text.length > 40 ? node.text.slice(0, 40) + '…' : node.text)}
            </div>

            {/* Cluster tag + author */}
            <div className="mt-1.5 flex items-center justify-center gap-1.5 flex-wrap">
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-mono uppercase tracking-[0.15em]"
                style={{
                  backgroundColor: `${node.color}18`,
                  color: node.color,
                  border: `1px solid ${node.color}25`,
                }}
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: node.color }}
                />
                {node.cluster}
              </span>
              {showLabel && node.authorName && (
                <span className="text-[9px] font-mono text-white/35">
                  {node.authorName}
                </span>
              )}
            </div>
          </div>
        </div>
      </Html>
    </group>
  );
}

function SwarmScene({
  ideas,
  edges,
  selectedIdeaId,
  onIdeaClick,
}: {
  ideas: any[];
  edges: any[];
  selectedIdeaId?: string | null;
  onIdeaClick?: (idea: any) => void;
}) {
  const controlsRef = useRef<any>(null);
  const graph = useMemo(() => buildGraph(ideas, edges), [ideas, edges]);
  const selectedNode = graph.nodes.find((node) => node.id === selectedIdeaId) || null;

  function CameraFocusAnimation({ focusNode }: { focusNode: any | null }) {
    const { camera } = useThree();
    const animationRef = useRef<{
      start: number;
      duration: number;
      fromPosition: THREE.Vector3;
      toPosition: THREE.Vector3;
      fromTarget: THREE.Vector3;
      toTarget: THREE.Vector3;
    } | null>(null);
    const lastFocusKeyRef = useRef('');

    useEffect(() => {
      const controls = controlsRef.current;
      if (!focusNode || !controls) return;

      const focusTarget = new THREE.Vector3(...focusNode.position);
      const focusKey = `${focusNode.id}:${focusNode.position.map((value: number) => value.toFixed(2)).join(':')}`;
      if (focusKey === lastFocusKeyRef.current) {
        return;
      }
      lastFocusKeyRef.current = focusKey;

      const currentTarget = controls.target.clone();
      const currentPosition = camera.position.clone();
      const offset = currentPosition.clone().sub(currentTarget);
      if (offset.lengthSq() === 0) {
        offset.set(0, 0, 24);
      }

      const desiredDistance = THREE.MathUtils.clamp(offset.length(), 10, 24);
      const nextPosition = focusTarget.clone().add(offset.normalize().multiplyScalar(desiredDistance));

      animationRef.current = {
        start: performance.now(),
        duration: 950,
        fromPosition: currentPosition,
        toPosition: nextPosition,
        fromTarget: currentTarget,
        toTarget: focusTarget,
      };
    }, [camera, focusNode]);

    useFrame(() => {
      const controls = controlsRef.current;
      const animation = animationRef.current;
      if (!controls || !animation) return;

      const elapsed = performance.now() - animation.start;
      const progress = Math.min(elapsed / animation.duration, 1);
      const eased =
        progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2;

      camera.position.lerpVectors(animation.fromPosition, animation.toPosition, eased);
      controls.target.lerpVectors(animation.fromTarget, animation.toTarget, eased);
      controls.update();

      if (progress >= 1) {
        animationRef.current = null;
      }
    });

    return null;
  }

  // Collect unique clusters for the legend
  const clusters = useMemo(() => {
    const map = new Map<string, { color: string; count: number }>();
    for (const node of graph.nodes) {
      const cluster = node.cluster || 'General';
      const existing = map.get(cluster);
      if (existing) {
        existing.count++;
      } else {
        map.set(cluster, { color: node.color, count: 1 });
      }
    }
    return Array.from(map.entries());
  }, [graph.nodes]);

  return (
    <>
      <color attach="background" args={['#050505']} />
      <fog attach="fog" args={['#050505', 25, 55]} />

      <PerspectiveCamera makeDefault position={[0, 0, 24]} fov={52} />
      <CameraFocusAnimation focusNode={selectedNode} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[10, 12, 8]} intensity={1.4} color="#e2ffe8" />
      <pointLight position={[-10, -6, -10]} intensity={0.9} color="#2dd4bf" />
      <pointLight position={[8, -8, 12]} intensity={0.5} color="#a78bfa" />
      <Stars radius={55} depth={20} count={1800} factor={2.2} saturation={0} fade speed={0.25} />

      <gridHelper args={[34, 17, '#11331f', '#0b1b14']} />

      {graph.links.map((link) => {
        const source = graph.nodeMap.get(link.source);
        const target = graph.nodeMap.get(link.target);
        if (!source || !target) return null;

        return (
          <Line
            key={link.key}
            points={[source.position, target.position]}
            color={link.isCluster ? '#9ca3af' : '#34d399'}
            lineWidth={link.isCluster ? 1.1 : 2.1}
            transparent
            opacity={link.isCluster ? 0.18 : 0.55}
            dashed={!link.isCluster}
            dashSize={link.isCluster ? 0 : 0.4}
            gapSize={link.isCluster ? 0 : 0.22}
          />
        );
      })}

      {graph.nodes.map((node) => (
        <SwarmNode
          key={node.id}
          node={node}
          isSelected={selectedIdeaId === node.id}
          onSelect={onIdeaClick}
        />
      ))}

      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.75}
        zoomSpeed={0.9}
        panSpeed={0.85}
        minDistance={8}
        maxDistance={52}
      />

      {/* Cluster legend overlay */}
      {clusters.length > 0 && (
        <Html position={[14.5, 11.5, 0]} transform={false}>
          <div className="pointer-events-none flex flex-col gap-1">
            {clusters.map(([name, { color, count }]) => (
              <div
                key={name}
                className="flex items-center gap-2 rounded-lg border border-white/8 bg-black/60 px-2.5 py-1 backdrop-blur-md"
              >
                <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}50` }} />
                <span className="text-[10px] font-mono text-white/60 whitespace-nowrap">{name}</span>
                <span className="text-[9px] font-mono text-white/30">{count}</span>
              </div>
            ))}
          </div>
        </Html>
      )}

      <Html position={[-14.5, 11.5, 0]} transform={false}>
        <div className="pointer-events-auto flex gap-2">
          <button
            onClick={() => controlsRef.current?.reset?.()}
            className="rounded-full border border-white/10 bg-black/60 px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-white/80 transition-colors hover:border-[#00FF00]/40 hover:text-white"
          >
            Reset View
          </button>
        </div>
      </Html>
    </>
  );
}

export default function IdeaSwarm({
  ideas,
  edges = [],
  selectedIdeaId = null,
  onIdeaClick,
}: {
  ideas: any[];
  edges?: any[];
  selectedIdeaId?: string | null;
  onIdeaClick?: (idea: any) => void;
}) {
  return (
    <div className="w-full h-full bg-[#050505] relative overflow-hidden">
      <Canvas gl={{ antialias: true }} dpr={[1, 2]}>
        <SwarmScene
          ideas={ideas}
          edges={edges}
          selectedIdeaId={selectedIdeaId}
          onIdeaClick={onIdeaClick}
        />
      </Canvas>

      {/* Top-left HUD */}
      <div className="pointer-events-none absolute left-5 top-5 flex flex-col gap-2">
        <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-black/60 px-3.5 py-2 backdrop-blur-xl">
          <div className="h-2 w-2 rounded-full bg-[#34D399] animate-pulse" />
          <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-white/65">
            Idea Swarm
          </span>
          <span className="ml-1 rounded-md bg-white/8 px-1.5 py-0.5 text-[10px] font-mono text-white/40">
            {ideas.length}
          </span>
        </div>
        <div className="rounded-xl border border-white/6 bg-black/45 px-3 py-2 text-[10px] text-white/40 backdrop-blur-md">
          <span className="text-white/55">Drag</span> orbit
          <span className="mx-1.5 text-white/15">|</span>
          <span className="text-white/55">Scroll</span> zoom
          <span className="mx-1.5 text-white/15">|</span>
          <span className="text-white/55">Right-drag</span> pan
        </div>
      </div>

      {/* Idea count empty state */}
      {ideas.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-2xl border border-white/8 bg-black/60 px-8 py-6 text-center backdrop-blur-xl">
            <div className="text-2xl mb-2">🧠</div>
            <p className="text-sm font-medium text-white/60">No ideas yet</p>
            <p className="mt-1 text-xs text-white/30">Speak or type to add the first idea</p>
          </div>
        </div>
      )}
    </div>
  );
}
