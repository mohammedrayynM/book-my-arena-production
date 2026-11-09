const fs = require('fs');
const code = fs.readFileSync('routes/owners.js', 'utf8');

// A simple bracket matching and statement tracking parser
const lines = code.split('\n');
let braceCount = 0;
const tryStack = [];

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Look for try block (simple regex)
    if (/\btry\b/.test(line) && !/\btry\b.*{.*}/.test(line)) {
        tryStack.push({ lineNum: i + 1, braceCount: braceCount });
    }

    // Count braces
    for (let char of line) {
        if (char === '{') {
            braceCount++;
        } else if (char === '}') {
            braceCount--;

            // If we closed a brace, check if it matches the brace count when try was entered
            if (tryStack.length > 0) {
                const topTry = tryStack[tryStack.length - 1];
                if (braceCount === topTry.braceCount) {
                    // The try block has closed its braces. Now check if the next lines contain catch or finally
                    let foundCatchOrFinally = false;
                    let searchLine = i + 1;
                    while (searchLine < lines.length && searchLine < i + 10) {
                        const nextLine = lines[searchLine];
                        if (/\b(catch|finally)\b/.test(nextLine)) {
                            foundCatchOrFinally = true;
                            break;
                        }
                        if (nextLine.trim() !== '' && !nextLine.trim().startsWith('//')) {
                            break;
                        }
                        searchLine++;
                    }

                    if (!foundCatchOrFinally) {
                        console.log(`Potential unmatched try block starting at line ${topTry.lineNum}`);
                    }
                    tryStack.pop();
                }
            }
        }
    }
}
console.log('Stack at end of file:', tryStack);
