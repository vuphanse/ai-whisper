import type { ReactNode, ReactElement } from "react";
import { Box, Text } from "ink";
import type { LogLine, RelayViewState } from "./relay-view-state.js";

export type Viewport = { offset: number; follow: boolean };

const GUTTER = 8; // right-aligned label column width
const STUCK_COLOR = "red"; // border + health + ⚠why share the stuck/alert color
const STATUS_ROWS = 9; // 7 status rows + round border (top + bottom)

function Row(props: { label: string; children: ReactNode; color?: string }) {
	const colorProp = props.color !== undefined ? { color: props.color } : {};
	return (
		<Box>
			<Text color="gray">{props.label.padStart(GUTTER)} │ </Text>
			<Text {...colorProp}>{props.children}</Text>
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
}): ReactElement {
	const { lines, viewport, height } = props;
	const h = Math.max(1, height);
	// `viewport.offset` = number of lines scrolled UP from the tail.
	// follow → pin to the newest window; otherwise walk back from the tail.
	const tailStart = Math.max(0, lines.length - h);
	const start = viewport.follow
		? tailStart
		: Math.max(0, tailStart - viewport.offset);
	const window = lines.slice(start, start + h);
	return (
		<Box flexDirection="column">
			{window.map((line, i) => {
				const latest =
					viewport.follow && line.kind === "event" && line.isLatest;
				const color = colorFor(line);
				// Ink's `color` rejects `undefined` under exactOptionalPropertyTypes;
				// spread it conditionally (same pattern as <Row>).
				const colorProp = color !== undefined ? { color } : {};
				return (
					<Text key={start + i} {...colorProp} inverse={latest}>
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
		<Box flexDirection="column">
			<Box flexDirection="column" borderStyle="round" borderColor={s.stuck ? STUCK_COLOR : "blue"}>
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
				height={Math.max(3, props.rows - STATUS_ROWS)}
			/>
		</Box>
	);
}
