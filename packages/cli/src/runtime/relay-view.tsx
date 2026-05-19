import type { ReactNode, ReactElement } from "react";
import { Box, Text } from "ink";
import type { RelayViewState } from "./relay-view-state.js";

export type Viewport = { offset: number; follow: boolean };

const GUTTER = 8; // right-aligned label column width
const STUCK_COLOR = "red"; // border + health + ⚠why share the stuck/alert color

function Row(props: { label: string; children: ReactNode; color?: string }) {
	const colorProp = props.color !== undefined ? { color: props.color } : {};
	return (
		<Box>
			<Text color="gray">{props.label.padStart(GUTTER)} │ </Text>
			<Text {...colorProp}>{props.children}</Text>
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
		</Box>
	);
}
