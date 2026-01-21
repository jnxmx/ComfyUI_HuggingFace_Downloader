
import re

with open("js/auto_download.js", "r") as f:
    text = f.read()

# Remove comments
text = re.sub(r'//.*', '', text)
text = re.sub(r'/\*[\s\S]*?\*/', '', text)
# Remove strings (approximate)
text = re.sub(r'"([^"\\]|\\.)*"', '""', text)
text = re.sub(r"'([^'\\]|\\.)*'", "''", text)
text = re.sub(r'`([^`\\]|\\.)*`', '``', text)

open_braces = 0
lines = text.split('\n')
stack = []

for i, line in enumerate(lines):
    line_stripped = line.strip()
    for char in line:
        if char == '{':
            open_braces += 1
            stack.append(i + 1)
            # print(f"Open at {i+1}: {line_stripped}")
        elif char == '}':
            open_braces -= 1
            if stack:
                stack.pop()
                # print(f"Close at {i+1}")
            else:
                print(f"Excess closing brace at line {i+1}")
    
    # Check specific checkpoints
    if "data.found.forEach" in line:
        print(f"At data.found loop (line {i+1}), stack size: {len(stack)}")
    if "data.mismatches.forEach" in line:
        print(f"At data.mismatches loop (line {i+1}), stack size: {len(stack)}")
    if "Missing Models Table" in line:
        print(f"At Missing Models (line {i+1}), stack size: {len(stack)}")

print(f"Final open braces: {open_braces}")
if open_braces > 0:
    print(f"Unclosed braces starting at lines: {stack[:5]}...")
