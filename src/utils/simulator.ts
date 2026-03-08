import { io, Socket } from 'socket.io-client';

const erIdeas = [
  { text: "Entity: STUDENT (student_id, name, email, dob)", cluster: "Entity" },
  { text: "Entity: COURSE (course_code, title, credits)", cluster: "Entity" },
  { text: "Entity: PROFESSOR (emp_id, name, office)", cluster: "Entity" },
  { text: "Entity: DEPARTMENT (dept_id, name)", cluster: "Entity" },
  { text: "Entity: ENROLLMENT (enrollment_id, grade, date)", cluster: "Entity" },
  { text: "Relationship: STUDENT makes ENROLLMENT", cluster: "Relationship" },
  { text: "Relationship: COURSE has ENROLLMENT", cluster: "Relationship" },
  { text: "Relationship: PROFESSOR teaches COURSE", cluster: "Relationship" },
  { text: "Relationship: PROFESSOR belongs_to DEPARTMENT", cluster: "Relationship" },
  { text: "Relationship: COURSE offered_by DEPARTMENT", cluster: "Relationship" },
];

export function startSimulation(numClients = 5): () => void {
  console.log(`Starting ER Diagram simulation with ${numClients} virtual students...`);
  const sockets: Socket[] = Array.from({ length: numClients }).map(() => io());

  let globalIdeas: any[] = [];
  let ideaIndex = 0;

  sockets.forEach((socket, i) => {
    socket.on('state_sync', (state) => {
      globalIdeas = state.ideas;
    });

    socket.on('idea_added', (idea) => {
      if (!globalIdeas.find(existing => existing.id === idea.id)) {
        globalIdeas.push(idea);
      }
    });

    socket.on('idea_updated', (updatedIdea) => {
      const index = globalIdeas.findIndex(idea => idea.id === updatedIdea.id);
      if (index !== -1) {
        globalIdeas[index] = updatedIdea;
      }
    });

    // Randomly add ideas from the erIdeas list
    const ideaInterval = setInterval(() => {
      // 15% chance every 2 seconds per client to add an idea
      if (Math.random() > 0.85 && ideaIndex < erIdeas.length) { 
        // We use a shared index to ensure all ideas get proposed eventually without too many duplicates
        const idea = erIdeas[ideaIndex % erIdeas.length];
        ideaIndex++; 
        if (idea) {
            const fakeNames = ["Ada", "Alan", "Grace", "Linus", "Tim", "Margaret"];
            const simName = `Sim-${fakeNames[Math.floor(Math.random() * fakeNames.length)]}`;
            socket.emit('add_idea', { text: idea.text, cluster: idea.cluster, authorName: simName });
        }
      }
    }, 2000);

    // Randomly vote on existing ideas
    const voteInterval = setInterval(() => {
      // 40% chance every 1 second per client to vote
      if (globalIdeas.length > 0 && Math.random() > 0.6) {
        const randomIdea = globalIdeas[Math.floor(Math.random() * globalIdeas.length)];
        socket.emit('vote_idea', { ideaId: randomIdea.id, tokens: 1 });
      }
    }, 1000);

    let forgingInterval: NodeJS.Timeout | null = null;
    
    // Only let the first client simulate forging to avoid constant overwriting
    if (i === 0) {
      // Set initial problem statement in the diagram
      setTimeout(() => {
         socket.emit('update_mermaid', 'erDiagram\n  PROBLEM_STATEMENT {\n    string Topic "University Course Registration"\n    string Goal "Design optimal ER Schema"\n  }');
      }, 1000);

      forgingInterval = setInterval(() => {
        if (globalIdeas.length > 0 && Math.random() > 0.3) {
          // Get top ideas by weight
          const topIdeas = [...globalIdeas]
            .sort((a, b) => (b.weight || 0) - (a.weight || 0))
            .slice(0, 10); // Take top 10
            
          let mermaid = "erDiagram\n";
          
          topIdeas.forEach(idea => {
            if (idea.text.startsWith("Entity: ")) {
              const match = idea.text.match(/Entity: (\w+) \((.*?)\)/);
              if (match) {
                const entityName = match[1];
                const attributes = match[2].split(',').map((s: string) => s.trim());
                mermaid += `  ${entityName} {\n`;
                attributes.forEach((attr: string) => {
                  mermaid += `    string ${attr.replace(/[^a-zA-Z0-9_]/g, '')}\n`;
                });
                mermaid += `  }\n`;
              }
            } else if (idea.text.startsWith("Relationship: ")) {
              const match = idea.text.match(/Relationship: (\w+) (\w+) (\w+)/);
              if (match) {
                mermaid += `  ${match[1]} ||--o{ ${match[3]} : "${match[2]}"\n`;
              }
            }
          });

          // If no valid ER syntax was generated yet, keep the problem statement
          if (mermaid === "erDiagram\n") {
             mermaid = 'erDiagram\n  PROBLEM_STATEMENT {\n    string Topic "University Course Registration"\n    string Goal "Design optimal ER Schema"\n  }';
          }

          socket.emit('update_mermaid', mermaid);
        }
      }, 4000); // Every 4 seconds
    }

    // Store intervals on the socket object for cleanup
    (socket as any).intervals = [ideaInterval, voteInterval];
    if (forgingInterval) (socket as any).intervals.push(forgingInterval);
  });

  // Return a cleanup function to stop the simulation
  return () => {
    console.log("Stopping simulation...");
    sockets.forEach(s => {
      const intervals = (s as any).intervals;
      if (intervals) {
        intervals.forEach(clearInterval);
      }
      s.disconnect();
    });
  };
}
