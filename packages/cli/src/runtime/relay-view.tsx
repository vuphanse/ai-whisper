import type { ReactNode, ReactElement } from "react";
import { Box, Text } from "ink";
import type { RelayViewState } from "./relay-view-state.js";

export type Viewport = { offset: number; follow: boolean };

const GUTTER = 8; // right-aligned label column width

function Row(props: { label: string; children: ReactNode; color?: string | undefined }) {
	return (
		<Box>
			<Text color="gray">{props.label.padStart(GUTTER)} │ </Text>
			{props.color !== undefined ? (
				<Text color={props.color}>{props.children}</Text>
			) : (
				<Text>{props.children}</Text>
			)}
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
	return (
		<Box flexDirection="column">
			<Box flexDirection="column" borderStyle="round" borderColor={s.stuck ? "red" : "blue"}>
				<Row label="wf">{s.wf}</Row>
				<Row label="progress">{s.progress}</Row>
				<Row label="elapsed" color="cyan">{s.elapsed}</Row>
				<Row label="turn">{s.turn}</Row>
				{s.stuck ? (
					<Row label="health" color="red">{s.health}</Row>
				) : (
					<Row label="health">{s.health}</Row>
				)}
				{s.stuck && s.why ? (
					<Row label="⚠ why" color="red">{s.why}</Row>
				) : (
					<Row label="live" color="yellow">{s.live}</Row>
				)}
				<Row label="last">{s.last}</Row>
			</Box>
		</Box>
	);
}
