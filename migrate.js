const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        file = path.resolve(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            results = results.concat(walk(file));
        } else {
            results.push(file);
        }
    });
    return results;
}

const srcDir = path.resolve(__dirname, 'client/src');
const files = walk(srcDir).filter(f => f.endsWith('.js') || f.endsWith('.jsx'));

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    let changed = false;

    // Fix router.replace
    if (content.includes('router.replace(')) {
        content = content.replace(/router\.replace\(([^)]+)\)/g, 'router($1, { replace: true })');
        changed = true;
    }

    // Fix Script from next/script
    if (content.includes("import Script from 'next/script'")) {
        content = content.replace(/import Script from 'next\/script'/g, "// Script from next/script replaced with standard script or useEffect");
        // Replace <Script ... /> with a comment or something else
        // In this project it's used for Razorpay and Google Maps usually.
        content = content.replace(/<Script([^>]+)\/>/g, '<!-- Script tag moved to index.html or handled via useEffect -->');
        changed = true;
    }

    // Replace window.location.href in components where router is available
    // (This is safer to do manually or more carefully, but let's try some)
    if (content.includes('window.location.href =') && (content.includes('useRouter') || content.includes('useNavigate'))) {
        content = content.replace(/window\.location\.href = ([^;]+)/g, 'router($1)');
        changed = true;
    }

    if (changed) {
        fs.writeFileSync(file, content, 'utf8');
        console.log(`Updated ${file}`);
    }
});
