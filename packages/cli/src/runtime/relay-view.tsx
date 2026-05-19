import type { ReactNode, ReactElement } from "react";
import { Box, Text } from "ink";
import type { LogLine, RelayViewState } from "./relay-view-state.js";

export type Viewport = { offset: number; follow: boolean };

const GUTTER = 8; // right-aligned label column width
const STUCK_COLOR = "red"; // border + health + ⚠why share the stuck/alert color
export const STATUS_BLOCK_ROWS = 7; // wf, progress, elapsed, turn, health, (why|live), last
export const STATUS_ROWS = STATUS_BLOCK_ROWS + 2; // + round border (top + bottom)

// Single source of truth for the log viewport height (status-block-aware,
// min 3 lines so small terminals still show a usable log). Used by the
// host's scroll clamp (handleKey) so it clamps to exactly what renders.
export function logViewportHeight(rows: number): number {
	return Math.max(3, rows - STATUS_ROWS);
}

function Row(props: { label: string; children: ReactNode; color?: string }) {
	const colorProp = props.color !== undefined ? { color: props.color } : {};
	return (
		<Box>
			<Box flexShrink={0}>
				<Text color="gray">{props.label.padStart(GUTTER)} │ </Text>
			</Box>
			<Text {...colorProp} wrap="truncate">{props.children}</Text>
		</Box>
	);
}

function colorFor(line: LogLine): string | undefined {
	if (line.kind === "phase-rule") return "gray";
	if (line.kind === "phase-summary") return line.ok ? "green" : "red";
	return undefined;
}

function LogViewport(props: {
	lines: LogLine[];
	viewport: Viewport;
	height: number;
	cols: number;
}): ReactElement {
	const { lines, viewport, height } = props;
	const h = Math.max(1, height);
	// `viewport.offset` = number of lines scrolled UP from the tail.
	// follow → pin to the newest window; otherwise walk back from the tail.
	const tailStart = Math.max(0, lines.length - h);
	const start = viewport.follow
		? tailStart
		: Math.min(tailStart, Math.max(0, tailStart - viewport.offset));
	const visible = lines.slice(start, start + h);
	return (
		<Box flexDirection="column">
			{visible.map((line, i) => {
				const latest =
					viewport.follow && line.kind === "event" && line.isLatest;
				const color = colorFor(line);
				// Ink's `color` rejects `undefined` under exactOptionalPropertyTypes;
				// spread it conditionally (same pattern as <Row>).
				const colorProp = color !== undefined ? { color } : {};
				return (
					<Text key={start + i} {...colorProp} inverse={latest} wrap="truncate">
						{line.text}
						{latest ? "  ◀ LATEST" : ""}
					</Text>
				);
			})}
		</Box>
	);
}

export function RelayView(props: {
	state: RelayViewState;
	viewport: Viewport;
	rows: number;
	cols: number;
}): ReactElement {
	const s = props.state;
	// Parent layout: status block now; Task 8 mounts the scrollable log viewport as a sibling Box here.
	return (
		<Box flexDirection="column" width={props.cols}>
			<Box flexDirection="column" borderStyle="round" borderColor={s.stuck ? STUCK_COLOR : "blue"}>
				{/* keep STATUS_BLOCK_ROWS in sync with these Row children */}
				<Row label="wf">{s.wf}</Row>
				<Row label="progress">{s.progress}</Row>
				<Row label="elapsed" color="cyan">{s.elapsed}</Row>
				<Row label="turn">{s.turn}</Row>
				<Row label="health" {...(s.stuck ? { color: STUCK_COLOR } : {})}>{s.health}</Row>
				{/* `why` is the row-selection sentinel (spec): the producer guarantees
				    stuck ⟺ non-empty why, so a non-stuck/why-null state shows the live
				    countdown. The red border + red health row also signal stuck. */}
				{s.stuck && s.why ? (
					<Row label="⚠ why" color={STUCK_COLOR}>{s.why}</Row>
				) : (
					<Row label="live" color="yellow">{s.live}</Row>
				)}
				<Row label="last">{s.last}</Row>
			</Box>
			<LogViewport
				lines={s.logLines}
				viewport={props.viewport}
				height={logViewportHeight(props.rows)}
				cols={props.cols}
			/>
		</Box>
	);
}
