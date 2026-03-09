import React, { useEffect, useRef, useMemo } from 'react';
import * as d3 from 'd3';

export default function IdeaSwarm({ ideas, edges = [], onIdeaClick }: { ideas: any[], edges?: any[], onIdeaClick?: (idea: any) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<d3.Simulation<any, undefined> | null>(null);
  const physicsNodes = useRef<any[]>([]);
  const linkElementsRef = useRef<any>(null);

  // Stable color scale for clusters
  const colorScale = useMemo(() => d3.scaleOrdinal(d3.schemeCategory10), []);

  useEffect(() => {
    if (!containerRef.current || !svgRef.current) return;
    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    // Merge new ideas into physics nodes to preserve their current velocity/position
    const existing = new Map(physicsNodes.current.map(n => [n.id, n]));
    physicsNodes.current = ideas.map(idea => {
      const old = existing.get(idea.id);
      return old ? { ...old, ...idea } : { 
        ...idea, 
        x: width / 2 + (Math.random() - 0.5) * 100, 
        y: height / 2 + (Math.random() - 0.5) * 100 
      };
    });

    // Create links between nodes of the same cluster to form constellations
    const links: any[] = [];
    const clusterGroups = d3.group(physicsNodes.current, d => d.cluster);
    clusterGroups.forEach(nodesInCluster => {
      for (let i = 1; i < nodesInCluster.length; i++) {
        links.push({ source: nodesInCluster[i-1].id, target: nodesInCluster[i].id, isCluster: true });
      }
    });

    // Add explicit edges from the Synthesizer
    edges.forEach(edge => {
      if (physicsNodes.current.find(n => n.id === edge.source) && physicsNodes.current.find(n => n.id === edge.target)) {
        links.push({ source: edge.source, target: edge.target, isCluster: false, reason: edge.reason });
      }
    });

    // Setup SVG links
    const svg = d3.select(svgRef.current);
    linkElementsRef.current = svg.selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', (d: any) => d.isCluster ? 'rgba(255,255,255,0.15)' : 'rgba(0,255,128,0.4)')
      .attr('stroke-width', (d: any) => d.isCluster ? 2 : 1)
      .attr('stroke-dasharray', (d: any) => d.isCluster ? 'none' : '4,4');

    if (!simulationRef.current) {
      simulationRef.current = d3.forceSimulation(physicsNodes.current)
        .force('charge', d3.forceManyBody().strength(-400))
        .force('collide', d3.forceCollide().radius((d: any) => 60 + (d.weight || 1) * 5))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .on('tick', () => {
          // Update HTML nodes for the text/bubbles
          if (!containerRef.current) return;
          const elements = containerRef.current.querySelectorAll('.idea-node');
          elements.forEach((el: any) => {
            const id = el.getAttribute('data-id');
            const node = physicsNodes.current.find(n => n.id === id);
            if (node) {
              el.style.transform = `translate(${node.x}px, ${node.y}px)`;
            }
          });

          // Update SVG links for the constellation lines
          if (linkElementsRef.current) {
            linkElementsRef.current
              .attr('x1', (d: any) => d.source.x)
              .attr('y1', (d: any) => d.source.y)
              .attr('x2', (d: any) => d.target.x)
              .attr('y2', (d: any) => d.target.y);
          }
        });
    } else {
      simulationRef.current.nodes(physicsNodes.current);
      simulationRef.current.alpha(0.3).restart();
    }

    // Update target forces based on semantic embeddings (targetPosition from server)
    simulationRef.current
      .force('link', d3.forceLink(links).id((d: any) => d.id).distance(150).strength(0.05))
      .force('x', d3.forceX((d: any) => {
        if (d.targetPosition) return width / 2 + d.targetPosition[0] * 30; // Scale X
        return width / 2;
      }).strength(0.1))
      .force('y', d3.forceY((d: any) => {
        if (d.targetPosition) return height / 2 + d.targetPosition[1] * 30; // Scale Y
        return height / 2;
      }).strength(0.1));

  }, [ideas, edges]);

  return (
    <div ref={containerRef} className="w-full h-full bg-[#050505] relative overflow-hidden">
      {/* SVG for links between nodes of the same cluster */}
      <svg ref={svgRef} className="absolute inset-0 w-full h-full pointer-events-none" />

      {ideas.map(idea => {
        const scale = 1 + (idea.weight * 0.1);
        return (
          <div
            key={idea.id}
            data-id={idea.id}
            onClick={() => onIdeaClick && onIdeaClick(idea)}
            className="idea-node absolute top-0 left-0 flex flex-col items-center justify-center cursor-pointer transition-transform hover:scale-110 z-10"
            style={{
              // Initial hidden/center position, D3 will take over immediately
              transform: `translate(-9999px, -9999px)`,
              marginLeft: '-100px', // Half of max width to center it
              marginTop: '-50px',
              width: '200px',
            }}
          >
            <div 
              className="w-6 h-6 rounded-full shadow-[0_0_20px_rgba(255,255,255,0.8)] border-2 border-white/50 transition-transform duration-300"
              style={{ backgroundColor: colorScale(idea.cluster), transform: `scale(${scale})` }}
            />
            <div className="mt-3 px-4 py-1.5 bg-black/60 backdrop-blur-md border border-white/10 rounded-full text-white text-sm text-center shadow-xl">
              {idea.text}
            </div>
            {idea.url && (
              <a 
                href={idea.url} 
                target="_blank" 
                rel="noreferrer" 
                className="mt-1.5 text-[10px] text-blue-400 hover:text-blue-300 underline bg-black/40 px-2 py-0.5 rounded truncate max-w-full"
                onClick={(e) => e.stopPropagation()}
              >
                {idea.urlTitle || 'Source'}
              </a>
            )}
            <div className="mt-1.5 text-[10px] font-mono text-white/50 uppercase tracking-widest bg-black/40 px-2 py-0.5 rounded">
              {idea.cluster}
            </div>
          </div>
        );
      })}
    </div>
  );
}
