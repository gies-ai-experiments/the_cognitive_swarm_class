import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  fontFamily: 'monospace'
});

export default function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>('');

  useEffect(() => {
    if (code) {
      const renderDiagram = async () => {
        try {
          const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
          const { svg } = await mermaid.render(id, code);
          setSvg(svg);
        } catch (error) {
          console.error('Mermaid rendering error:', error);
          // Fallback or show error
        }
      };
      renderDiagram();
    }
  }, [code]);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 overflow-auto bg-[#141414] rounded-lg border border-white/5 p-4">
        {svg ? (
          <div dangerouslySetInnerHTML={{ __html: svg }} className="w-full h-full flex items-center justify-center" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white/30 font-mono text-sm">
            Waiting for swarm consensus...
          </div>
        )}
      </div>
      <div className="mt-4 p-3 bg-black/50 rounded-lg border border-white/5 font-mono text-xs text-white/50 whitespace-pre-wrap overflow-auto max-h-40">
        {code || 'No code generated yet.'}
      </div>
    </div>
  );
}
