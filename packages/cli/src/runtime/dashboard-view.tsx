import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LogLine } from "./relay-view-state.js";
import type { WallState, WallPaneState } from "./dashboard-state.js";

const MIN_PANE_COLS = 40;
const MIN_PANE_ROWS = 5;

export function gridCapacity(cols: number, rows: number): number {
	const c = Math.max(1, Math.floor(cols / MIN_PANE_COLS));
	const r = Math.max(1, Math.floor(rows / MIN_PANE_ROWS));
	return c * r;
}

function tailText(l: LogLine): string {
	return l.text;
}

function WallPane(props: {
	pane: WallPaneState;
	selected: boolean;
	width: number;
}): ReactElement {
	const { pane } = props;
	const borderColor = pane.stuck ? "red" : props.selected ? "cyan" : "gray";
	const healthColorProp = pane.stuck ? { color: "red" as const } : {};
	return (
		<Box
			flexDirection="column"
			width={props.width}
			borderStyle="round"
			borderColor={borderColor}
		>
			<Text wrap="truncate" bold>
				{pane.header}
			</Text>
			<Text wrap="truncate" {...healthColorProp}>
				{pane.healthLine}
			</Text>
			{pane.logTail.map((l, i) => (
				<Text key={i} wrap="truncate" color="gray">
					{tailText(l)}
				</Text>
			))}
		</Box>
	);
}

export function Wall(props: {
	state: WallState;
	cols: number;
	rows: number;
}): ReactElement {
	const { state } = props;
	if (state.panes.length === 0) {
		return (
			<Box width={props.cols} flexDirection="column">
				<Text color="gray">no active collabs (last 30m)</Text>
			</Box>
		);
	}
	const colsCount = Math.max(1, Math.floor(props.cols / MIN_PANE_COLS));
	const paneWidth = Math.floor(props.cols / colsCount);
	const rowsOfPanes: WallPaneState[][] = [];
	for (let i = 0; i < state.panes.length; i += colsCount) {
		rowsOfPanes.push(state.panes.slice(i, i + colsCount));
	}
	return (
		<Box flexDirection="column" width={props.cols}>
			{rowsOfPanes.map((rowPanes, ri) => (
				<Box key={ri} flexDirection="row">
					{rowPanes.map((p, ci) => {
						const idx = ri * colsCount + ci;
						return (
							<WallPane
								key={p.collabId}
								pane={p}
								selected={idx === state.selected}
								width={paneWidth}
							/>
						);
					})}
				</Box>
			))}
			<Text color="gray">
				{`page ${state.page + 1}/${Math.max(1, state.pageCount)} · ${state.totalRuns} runs · ↵ inspect · [ ] page · q quit`}
			</Text>
		</Box>
	);
}
