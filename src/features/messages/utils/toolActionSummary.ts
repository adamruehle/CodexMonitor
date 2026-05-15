export type ActionSummary = {
  label: string;
  value?: string;
  detail?: string;
  rawCommand?: string;
};

export function cleanCommandText(commandText: string) {
  if (!commandText) {
    return "";
  }
  const trimmed = commandText.trim();
  const withoutLabel = trimmed.replace(/^Command:\s*/i, "");
  const shellMatch = withoutLabel.match(
    /^(?:\/\S+\/)?(?:bash|zsh|sh|fish)(?:\.exe)?\s+-lc\s+(['"])([\s\S]+)\1$/,
  );
  const unquotedShellMatch = withoutLabel.match(
    /^(?:\/\S+\/)?(?:bash|zsh|sh|fish)(?:\.exe)?\s+-lc\s+([\s\S]+)$/,
  );
  const inner = shellMatch
    ? shellMatch[2]
    : unquotedShellMatch
      ? unquotedShellMatch[1]
      : withoutLabel;
  const cdMatch = inner.match(
    /^\s*cd\s+[^&;]+(?:\s*&&\s*|\s*;\s*)([\s\S]+)$/i,
  );
  const stripped = cdMatch ? cdMatch[1] : inner;
  return stripped.trim();
}

function shellWords(command: string) {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (current) {
    words.push(current);
  }
  return words;
}

function splitShellChain(command: string) {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (
      (char === "&" && next === "&") ||
      (char === "|" && next === "|") ||
      char === ";"
    ) {
      const segment = current.trim();
      if (segment) {
        segments.push(segment);
      }
      current = "";
      if (char !== ";") {
        index += 1;
      }
      continue;
    }
    current += char;
  }

  const finalSegment = current.trim();
  if (finalSegment) {
    segments.push(finalSegment);
  }
  return segments;
}

function basenameOrPath(path: string) {
  if (!path) {
    return "";
  }
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function quoteSnippet(value: string, maxLength = 52) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const collapsed = trimmed.replace(/\s+/g, " ");
  const short =
    collapsed.length > maxLength
      ? `${collapsed.slice(0, Math.max(0, maxLength - 1))}...`
      : collapsed;
  const quote = short.includes('"') && !short.includes("'") ? "'" : '"';
  return `${quote}${short}${quote}`;
}

function nonOptionTokens(tokens: string[]) {
  const values: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token === "--") {
      continue;
    }
    if (token.startsWith("-")) {
      if (
        [
          "-g",
          "--glob",
          "-e",
          "--regexp",
          "-f",
          "--file",
          "-C",
          "--context",
        ].includes(token)
      ) {
        index += 1;
      } else if (token.includes("=")) {
        continue;
      }
      continue;
    }
    values.push(token);
  }
  return values;
}

function formatFileCount(files: string[]) {
  const unique = Array.from(new Set(files.filter(Boolean)));
  if (unique.length === 0) {
    return "";
  }
  if (unique.length === 1) {
    return basenameOrPath(unique[0]);
  }
  return `${unique.length} files`;
}

function sedLineRange(segment: string) {
  const match = segment.match(/\bsed\s+-n\s+(['"])?(\d+),(\d+)p\1?/);
  if (!match) {
    return null;
  }
  return `${match[2]}-${match[3]}`;
}

function summarizeReadCommand(segment: string): ActionSummary | null {
  const nlSedMatch = segment.match(
    /\bnl\s+-ba\s+([^\s|]+)[\s\S]*\|\s*sed\s+-n\s+(['"])?(\d+),(\d+)p\2?/,
  );
  if (nlSedMatch) {
    return {
      label: "read",
      value: `${basenameOrPath(nlSedMatch[1])} lines ${nlSedMatch[3]}-${nlSedMatch[4]}`,
    };
  }

  const sedRange = sedLineRange(segment);
  const tokens = shellWords(segment);
  const executable = basenameOrPath(tokens[0] ?? "").toLowerCase();
  if (executable === "sed" && sedRange) {
    const files = nonOptionTokens(tokens).filter(
      (token) => !/^\d+,\d+p$/.test(token),
    );
    const target = formatFileCount(files);
    return {
      label: "read",
      value: target ? `${target} lines ${sedRange}` : `lines ${sedRange}`,
    };
  }
  if (executable === "nl") {
    const files = nonOptionTokens(tokens);
    const target = formatFileCount(files);
    return {
      label: "read",
      value: target || "numbered file output",
    };
  }
  if (["cat", "head", "tail"].includes(executable)) {
    const files = nonOptionTokens(tokens);
    const target = formatFileCount(files);
    return {
      label: "read",
      value: target || "file contents",
    };
  }
  return null;
}

function summarizeSearchCommand(segment: string): ActionSummary | null {
  const tokens = shellWords(segment);
  const executable = basenameOrPath(tokens[0] ?? "").toLowerCase();
  if (executable !== "rg" && executable !== "grep") {
    return null;
  }
  if (tokens.includes("--files")) {
    const target = nonOptionTokens(tokens).find((token) => token !== "--files");
    return {
      label: "list",
      value: target ? `files under ${basenameOrPath(target)}` : "workspace files",
    };
  }
  const values = nonOptionTokens(tokens);
  const query = values[0] ?? "";
  const targets = values.slice(1);
  const target = formatFileCount(targets);
  return {
    label: "search",
    value: [target || "workspace", query ? `for ${quoteSnippet(query)}` : ""]
      .filter(Boolean)
      .join(" "),
  };
}

function summarizeGitCommand(segment: string): ActionSummary | null {
  const tokens = shellWords(segment);
  if (tokens[0] !== "git") {
    return null;
  }
  const subcommand = tokens[1] ?? "";
  if (subcommand === "status") {
    return { label: "inspect", value: "git status" };
  }
  if (subcommand === "diff") {
    if (tokens.includes("--check")) {
      return { label: "validate", value: "patch whitespace" };
    }
    const separator = tokens.indexOf("--");
    const paths =
      separator >= 0
        ? tokens.slice(separator + 1)
        : tokens.slice(2).filter((token) => !token.startsWith("-"));
    return {
      label: "inspect",
      value: paths.length ? `diff for ${formatFileCount(paths)}` : "git diff",
    };
  }
  if (subcommand === "show") {
    return { label: "inspect", value: "commit or file details" };
  }
  if (subcommand === "log") {
    return { label: "inspect", value: "git history" };
  }
  if (subcommand === "branch") {
    return { label: "inspect", value: "git branches" };
  }
  return { label: "git", value: subcommand || "command" };
}

function summarizeValidationCommand(segment: string): ActionSummary | null {
  const tokens = shellWords(segment);
  const executable = basenameOrPath(tokens[0] ?? "").toLowerCase();
  if (executable === "node" && tokens[1] === "--check") {
    return {
      label: "validate",
      value: tokens[2]
        ? `JavaScript syntax in ${basenameOrPath(tokens[2])}`
        : "JavaScript syntax",
    };
  }
  if (executable === "npm" && tokens[1] === "run") {
    const script = tokens[2] ?? "";
    if (/test/i.test(script)) {
      return { label: "test", value: tokens.slice(2).join(" ") || "npm tests" };
    }
    if (/typecheck|tsc/i.test(script)) {
      return { label: "validate", value: "TypeScript types" };
    }
    if (/build/i.test(script)) {
      return { label: "build", value: script };
    }
    return { label: "run", value: `npm script ${script || ""}`.trim() };
  }
  if (executable === "npm" && /^test/.test(tokens[1] ?? "")) {
    return { label: "test", value: "npm tests" };
  }
  if (executable === "cargo") {
    const subcommand = tokens[1] ?? "";
    if (subcommand === "check") {
      return { label: "validate", value: "Rust compile checks" };
    }
    if (subcommand === "test") {
      return { label: "test", value: "Rust tests" };
    }
    if (subcommand === "build") {
      return { label: "build", value: "Rust project" };
    }
  }
  if (executable === "tsc") {
    return { label: "validate", value: "TypeScript types" };
  }
  if (executable === "playwright" && tokens.includes("--version")) {
    return { label: "inspect", value: "Playwright version" };
  }
  return null;
}

function summarizeFilesystemCommand(segment: string): ActionSummary | null {
  const tokens = shellWords(segment);
  const executable = basenameOrPath(tokens[0] ?? "").toLowerCase();
  if (executable === "ls" || executable === "tree") {
    const target = nonOptionTokens(tokens)[0];
    return {
      label: "list",
      value: target ? basenameOrPath(target) : "directory contents",
    };
  }
  if (executable === "find") {
    const target = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : "";
    return {
      label: "find",
      value: target ? `files under ${basenameOrPath(target)}` : "files",
    };
  }
  if (executable === "pwd") {
    return { label: "inspect", value: "current directory" };
  }
  if (executable === "date") {
    return { label: "inspect", value: "current date and time" };
  }
  if (executable === "which" || executable === "command") {
    return { label: "inspect", value: "available command path" };
  }
  return null;
}

function summarizeCommandSegment(segment: string): ActionSummary | null {
  return (
    summarizeReadCommand(segment) ??
    summarizeSearchCommand(segment) ??
    summarizeGitCommand(segment) ??
    summarizeValidationCommand(segment) ??
    summarizeFilesystemCommand(segment)
  );
}

function joinCommandSummaries(summaries: ActionSummary[]) {
  if (summaries.length === 0) {
    return null;
  }
  if (summaries.length === 1) {
    return summaries[0];
  }
  const [first, ...rest] = summaries;
  return {
    label: first.label,
    value: [first.value, ...rest.map((summary) => `${summary.label} ${summary.value}`)]
      .filter(Boolean)
      .join("; "),
  };
}

export function summarizeCommandAction(commandText: string): ActionSummary {
  const cleanedCommand = cleanCommandText(commandText);
  const segments = splitShellChain(cleanedCommand);
  const summaries = segments
    .map((segment) => summarizeCommandSegment(segment))
    .filter((summary): summary is ActionSummary => Boolean(summary));
  const joined = joinCommandSummaries(summaries);
  if (joined) {
    return {
      ...joined,
      detail: cleanedCommand,
      rawCommand: cleanedCommand,
    };
  }
  return {
    label: "run",
    value: cleanedCommand || "shell command",
    detail: cleanedCommand,
    rawCommand: cleanedCommand,
  };
}
