const fs = require('fs');
const path = 'client/app/globals.css';

try {
  let content = fs.readFileSync(path, 'utf8');
  
  // Target the specific block at the end
  const target = `.slot-capsule {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 12px 8px !important;
  border-radius: 12px !important;
  font-size: 0.85rem !important;
  font-weight: 600 !important;
  background: var(--bg-card) !important;
  border: 1px solid var(--border-subtle) !important;
  color: var(--text-secondary) !important;
}`;

  const replacement = `.slot-capsule {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 12px 8px !important;
  border-radius: 12px !important;
  font-size: 0.85rem !important;
  font-weight: 600 !important;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
}`;

  // Use a regex to be more flexible with line endings
  // Replace !important; with ; for those three lines
  const lines = content.split(/\r?\n/);
  const newLines = lines.map(line => {
    if (line.includes('background: var(--bg-card) !important;')) return line.replace(' !important', '');
    if (line.includes('border: 1px solid var(--border-subtle) !important;')) return line.replace(' !important', '');
    if (line.includes('color: var(--text-secondary) !important;')) return line.replace(' !important', '');
    return line;
  });

  fs.writeFileSync(path, newLines.join('\n'));
  console.log('Fixed globals.css successfully');
} catch (err) {
  console.error('Error:', err.message);
}
