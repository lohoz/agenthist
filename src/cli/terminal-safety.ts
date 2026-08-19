const ESCAPE = "\u001b";
const BELL = "\u0007";
const STRING_TERMINATOR = "\u009c";

const SAFE_SGR = new Set([
  "0",
  "1",
  "2",
  "7;1",
  "31",
  "32",
  "33",
  "36",
  "1;31",
  "1;32",
  "1;33",
  "1;36",
  "2;31",
  "2;36",
]);

function csiFinal(value: string, offset: number): number | undefined {
  for (let index = offset; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
    if (!((code >= 0x20 && code <= 0x3f))) return undefined;
  }
  return undefined;
}

function stringControlEnd(value: string, offset: number): number {
  for (let index = offset; index < value.length; index++) {
    const character = value[index]!;
    if (character === BELL || character === STRING_TERMINATOR) return index + 1;
    if (character === ESCAPE && value[index + 1] === "\\") return index + 2;
  }
  return value.length;
}

function sanitize(value: string, preserveSafeSgr: boolean): string {
  let result = "";
  for (let index = 0; index < value.length;) {
    const character = value[index]!;
    const code = value.charCodeAt(index);
    if (character === ESCAPE) {
      const introducer = value[index + 1];
      if (introducer === "[") {
        const final = csiFinal(value, index + 2);
        if (final === undefined) {
          index++;
          continue;
        }
        const parameters = value.slice(index + 2, final);
        if (preserveSafeSgr && value[final] === "m" && SAFE_SGR.has(parameters)) {
          result += value.slice(index, final + 1);
        }
        index = final + 1;
        continue;
      }
      if (introducer === "]" || introducer === "P" || introducer === "X" ||
        introducer === "^" || introducer === "_") {
        index = stringControlEnd(value, index + 2);
        continue;
      }
      index += introducer === undefined ? 1 : 2;
      continue;
    }
    if (code === 0x9b) {
      const final = csiFinal(value, index + 1);
      index = final === undefined ? index + 1 : final + 1;
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = stringControlEnd(value, index + 1);
      continue;
    }
    if ((code >= 0 && code <= 0x1f && character !== "\n" && character !== "\t") ||
      (code >= 0x7f && code <= 0x9f)) {
      index++;
      continue;
    }
    result += character;
    index++;
  }
  return result;
}

export function sanitizeTerminalText(value: string): string {
  return sanitize(value, false);
}

export function sanitizeHumanOutput(value: string): string {
  return sanitize(value, true);
}
