import type { ReactNode } from "react";

const SAFE_URL_RE = /^(https?:\/\/|mailto:)/i;
const INLINE_TOKEN_RE =
	/(`[^`\n]+`|\[[^\]\n]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~)/g;
const LINK_RE = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/;
const UNORDERED_LIST_RE = /^\s*[-*+]\s+/;
const ORDERED_LIST_RE = /^\s*\d+\.\s+/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const BLOCKQUOTE_STRIP_RE = /^>\s?/;
const ORDERED_STRIP_RE = /^\s*\d+\.\s+/;
const UNORDERED_STRIP_RE = /^\s*[-*+]\s+/;
const HEADING_BLOCK_RE = /^(#{1,6})\s+/;
const CARRIAGE_RETURN_RE = /\r\n?/g;

const isSafeUrl = (url: string): boolean => SAFE_URL_RE.test(url.trim());
const isUnorderedListItem = (line: string): boolean =>
	UNORDERED_LIST_RE.test(line);
const isOrderedListItem = (line: string): boolean => ORDERED_LIST_RE.test(line);

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: markdown parser requires sequential token matching
function parseInline(text: string, keyPrefix: string): ReactNode[] {
	const out: ReactNode[] = [];
	let lastIndex = 0;
	let tokenIndex = 0;

	for (const match of text.matchAll(INLINE_TOKEN_RE)) {
		const token = match[0];
		const idx = match.index ?? 0;

		if (idx > lastIndex) {
			out.push(text.slice(lastIndex, idx));
		}

		const key = `${keyPrefix}-t-${tokenIndex++}`;

		if (token.startsWith("`") && token.endsWith("`")) {
			out.push(
				<code
					className="rounded border bg-muted px-1 py-0.5 font-mono text-sm"
					key={key}
				>
					{token.slice(1, -1)}
				</code>
			);
		} else if (token.startsWith("**") && token.endsWith("**")) {
			out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
		} else if (token.startsWith("__") && token.endsWith("__")) {
			out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
		} else if (token.startsWith("*") && token.endsWith("*")) {
			out.push(<em key={key}>{token.slice(1, -1)}</em>);
		} else if (token.startsWith("_") && token.endsWith("_")) {
			out.push(<em key={key}>{token.slice(1, -1)}</em>);
		} else if (token.startsWith("~~") && token.endsWith("~~")) {
			out.push(<del key={key}>{token.slice(2, -2)}</del>);
		} else if (
			token.startsWith("[") &&
			token.includes("](") &&
			token.endsWith(")")
		) {
			const linkMatch = token.match(LINK_RE);
			if (linkMatch) {
				const label = linkMatch[1];
				const href = linkMatch[2];
				if (isSafeUrl(href)) {
					out.push(
						<a
							className="font-medium text-primary underline underline-offset-4"
							href={href}
							key={key}
							rel="noreferrer"
							target="_blank"
						>
							{label}
						</a>
					);
				} else {
					out.push(label);
				}
			} else {
				out.push(token);
			}
		} else {
			out.push(token);
		}

		lastIndex = idx + token.length;
	}

	if (lastIndex < text.length) {
		out.push(text.slice(lastIndex));
	}

	return out;
}

function renderInlineLines(text: string, keyPrefix: string): ReactNode[] {
	const lines = text.split("\n");
	const out: ReactNode[] = [];
	for (let idx = 0; idx < lines.length; idx++) {
		if (idx > 0) {
			out.push(<br key={`${keyPrefix}-br-${idx}`} />);
		}
		out.push(...parseInline(lines[idx], `${keyPrefix}-l-${idx}`));
	}
	return out;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: markdown block parser requires sequential pattern matching
export function MarkdownText({ text }: { text: string }) {
	const source = text.replace(CARRIAGE_RETURN_RE, "\n");
	const lines = source.split("\n");
	const nodes: ReactNode[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		if (!trimmed) {
			i += 1;
			continue;
		}

		if (trimmed.startsWith("```")) {
			const lang = trimmed.slice(3).trim();
			const codeLines: string[] = [];
			i += 1;
			while (i < lines.length && !lines[i].trim().startsWith("```")) {
				codeLines.push(lines[i]);
				i += 1;
			}
			if (i < lines.length && lines[i].trim().startsWith("```")) {
				i += 1;
			}
			nodes.push(
				<pre
					className="my-4 overflow-x-auto rounded-lg bg-zinc-950 p-4 text-sm text-zinc-50"
					key={`code-${nodes.length}`}
				>
					<code className={lang ? `language-${lang}` : undefined}>
						{codeLines.join("\n")}
					</code>
				</pre>
			);
			continue;
		}

		const headingMatch = trimmed.match(HEADING_RE);
		if (headingMatch) {
			const level = headingMatch[1].length;
			const content = headingMatch[2];
			const key = `h-${nodes.length}`;
			const headings: Record<number, ReactNode> = {
				1: (
					<h1 className="mb-4 font-bold text-2xl tracking-tight" key={key}>
						{renderInlineLines(content, key)}
					</h1>
				),
				2: (
					<h2
						className="mt-6 mb-3 font-semibold text-xl tracking-tight first:mt-0"
						key={key}
					>
						{renderInlineLines(content, key)}
					</h2>
				),
				3: (
					<h3
						className="mt-4 mb-2 font-semibold text-lg tracking-tight first:mt-0"
						key={key}
					>
						{renderInlineLines(content, key)}
					</h3>
				),
				4: (
					<h4
						className="mt-4 mb-2 font-semibold text-base first:mt-0"
						key={key}
					>
						{renderInlineLines(content, key)}
					</h4>
				),
				5: (
					<h5 className="my-2 font-semibold text-sm first:mt-0" key={key}>
						{renderInlineLines(content, key)}
					</h5>
				),
				6: (
					<h6 className="my-2 font-semibold text-sm first:mt-0" key={key}>
						{renderInlineLines(content, key)}
					</h6>
				),
			};
			nodes.push(headings[level]);
			i += 1;
			continue;
		}

		if (trimmed.startsWith(">")) {
			const quoteLines: string[] = [];
			while (i < lines.length && lines[i].trim().startsWith(">")) {
				quoteLines.push(lines[i].trim().replace(BLOCKQUOTE_STRIP_RE, ""));
				i += 1;
			}
			const content = quoteLines.join("\n");
			const key = `q-${nodes.length}`;
			nodes.push(
				<blockquote
					className="my-2 border-muted-foreground/30 border-l-2 pl-4 text-muted-foreground italic"
					key={key}
				>
					{renderInlineLines(content, key)}
				</blockquote>
			);
			continue;
		}

		if (isUnorderedListItem(line) || isOrderedListItem(line)) {
			const ordered = isOrderedListItem(line);
			const items: string[] = [];
			while (i < lines.length) {
				const candidate = lines[i];
				if (ordered && isOrderedListItem(candidate)) {
					items.push(candidate.replace(ORDERED_STRIP_RE, ""));
					i += 1;
					continue;
				}
				if (!ordered && isUnorderedListItem(candidate)) {
					items.push(candidate.replace(UNORDERED_STRIP_RE, ""));
					i += 1;
					continue;
				}
				if (!candidate.trim()) {
					i += 1;
					break;
				}
				break;
			}
			const key = `list-${nodes.length}`;
			if (ordered) {
				nodes.push(
					<ol className="my-3 ml-6 list-decimal [&>li]:mt-1" key={key}>
						{items.map((item, idx) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: list items have no stable id
							<li key={`${key}-i-${idx}`}>
								{renderInlineLines(item, `${key}-i-${idx}`)}
							</li>
						))}
					</ol>
				);
			} else {
				nodes.push(
					<ul className="my-3 ml-6 list-disc [&>li]:mt-1" key={key}>
						{items.map((item, idx) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: list items have no stable id
							<li key={`${key}-i-${idx}`}>
								{renderInlineLines(item, `${key}-i-${idx}`)}
							</li>
						))}
					</ul>
				);
			}
			continue;
		}

		const paragraphLines: string[] = [];
		while (i < lines.length) {
			const current = lines[i];
			const currentTrimmed = current.trim();
			if (!currentTrimmed) {
				break;
			}
			if (
				currentTrimmed.startsWith("```") ||
				currentTrimmed.startsWith(">") ||
				HEADING_BLOCK_RE.test(currentTrimmed) ||
				isUnorderedListItem(current) ||
				isOrderedListItem(current)
			) {
				break;
			}
			paragraphLines.push(current);
			i += 1;
		}
		const content = paragraphLines.join("\n");
		const key = `p-${nodes.length}`;
		nodes.push(
			<p className="my-3 leading-7 first:mt-0 last:mb-0" key={key}>
				{renderInlineLines(content, key)}
			</p>
		);
	}

	return <div>{nodes}</div>;
}
