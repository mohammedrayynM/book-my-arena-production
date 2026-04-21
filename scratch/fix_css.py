import os

file_path = r'c:\book my arena folder\client\app\globals.css'
with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Fix the last block
new_lines = []
for line in lines:
    if '.slot-capsule {' in line:
        # We want to change the block that has !important on background
        pass
    
    # Simple search and replace for these specific lines in the last block
    if 'background: var(--bg-card) !important;' in line:
        new_lines.append(line.replace(' !important', ''))
    elif 'border: 1px solid var(--border-subtle) !important;' in line:
        new_lines.append(line.replace(' !important', ''))
    elif 'color: var(--text-secondary) !important;' in line:
        new_lines.append(line.replace(' !important', ''))
    else:
        new_lines.append(line)

with open(file_path, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print("Fixed globals.css successfully")
