        const fs = require('fs');
const path = require('path');

function replaceInFiles(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            if (file === 'node_modules' || file === '.next' || file === '.git') continue;
            replaceInFiles(fullPath);
        } else if (fullPath.endsWith('.js') || fullPath.endsWith('.md') || fullPath.endsWith('.css')) {
            let content = fs.readFileSync(fullPath, 'utf8');
            let modified = content
                .replace(/BookMyArena/g, 'BookArena')
                .replace(/Book My Arena/gi, 'Book Arena')
                // replace logo html pattern
                .replace(/Book<span className="accent">My<\/span>Arena/g, 'Book<span className="accent">Arena<\/span>')
                .replace(/<div className="logo-icon">🏟️<\/div>/g, '<div className="logo-icon">👑</div>');

            if (content !== modified) {
                fs.writeFileSync(fullPath, modified);
                console.log('Updated:', fullPath);
            }
        }
    }
}

replaceInFiles(path.join(__dirname, 'client'));
replaceInFiles(path.join(__dirname, 'server'));

console.log("Done");
