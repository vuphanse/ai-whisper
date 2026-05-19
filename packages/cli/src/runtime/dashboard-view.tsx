import { Box, Text, useInput, useStdin } from "ink";
import type { ReactElement, ReactNode } from "react";
import type { LogLine } from "./relay-view-state.js";
import type { WallState, WallPaneState } from "./dashboard-state.js";
import { RelayView, type Viewport } from "./relay-view.js";
import { fmtDur } from "./relay-view-state.js";
import type { InspectorState } from "./dashboard-state.js";

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

export type InspectorSection = "live" | "timeline" | "evidence" | "cost";

function tabBar(active: InspectorSection): string {
	const t = (k: InspectorSection, n: string) =>
		k === active ? `[${n}]` : ` ${n} `;
	return `${t("live", "1 Live")}${t("timeline", "2 Timeline")}${t("evidence", "3 Evidence")}${t("cost", "4 Cost")}`;
}

export function Inspector(props: {
	state: InspectorState;
	section: InspectorSection;
	viewport: Viewport;
	cols: number;
	rows: number;
	label: string;
	workflowType: string | null;
}): ReactElement {
	const s = props.state;
	const head = `${props.label} · ${props.workflowType ?? "manual relay"}`;
	const innerRows = Math.max(3, props.rows - 2);
	return (
		<Box flexDirection="column" width={props.cols}>
			<Text wrap="truncate" bold>
				{head}
			</Text>
			<Text wrap="truncate" color="gray">
				{`${tabBar(props.section)}   Esc wall · q quit`}
			</Text>
			{props.section === "live" ? (
				<RelayView
					state={s.live}
					viewport={props.viewport}
					rows={innerRows}
					cols={props.cols}
				/>
			) : props.section === "timeline" ? (
				<Box flexDirection="column">
					<Text wrap="truncate" color="gray">
						PHASE ROUNDS TIME ~TOK OUTCOME
					</Text>
					{s.timeline.map((p) => (
						<Text key={p.phaseIndex} wrap="truncate">
							{`${p.phaseName}  ${p.roundsUsed}/${p.maxRounds}  ${
								p.durationMs == null ? "–" : fmtDur(p.durationMs)
							}  ≈${p.estInTokens + p.estOutTokens}  ${p.outcome ?? "⋯"}`}
						</Text>
					))}
					<Text wrap="truncate" bold>
						{`TOTAL  ≈${
							s.cost.estInputTokens + s.cost.estOutputTokens
						}  ${fmtDur(s.cost.totalMs)}`}
					</Text>
				</Box>
			) : props.section === "evidence" ? (
				<Box flexDirection="column">
					<Text wrap="truncate" color="gray">
						{`${s.evidence.phase ?? "—"} · chain ${s.evidence.chainId ?? "—"}`}
					</Text>
					{s.evidence.items.map((it, i) => (
						<Text key={i} wrap="truncate">
							{`R${it.round ?? "-"} ${it.step ?? "-"} ${it.sender}→${it.target} ${
								it.verdict ?? "-"
							} ${it.confidence ?? "-"} ${it.reasonExcerpt}`}
						</Text>
					))}
					{s.evidence.diagnostics.map((d, i) => (
						<Text key={`d${i}`} wrap="truncate" color="gray">
							{`${d.kind}: ${d.text}`}
						</Text>
					))}
					<Text wrap="truncate" color="yellow">
						{`▸ ${s.evidence.likelyCause}`}
					</Text>
				</Box>
			) : (
				<Box flexDirection="column">
					<Text wrap="truncate">
						{`total ${fmtDur(s.cost.totalMs)} · in ≈${
							s.cost.estInputTokens
						} · out ≈${s.cost.estOutputTokens}  (est, not metered)`}
					</Text>
					{s.cost.perPhase.map((p, i) => (
						<Text key={i} wrap="truncate" color="gray">
							{`${p.phaseName}  in ≈${p.estInTokens}  out ≈${
								p.estOutTokens
							}  ${p.durationMs == null ? "–" : fmtDur(p.durationMs)}`}
						</Text>
					))}
				</Box>
			)}
		</Box>
	);
}

type KeyEv = {
	upArrow?: boolean;
	downArrow?: boolean;
	escape?: boolean;
	key?: string;
};

// Mounted ONLY when raw mode is supported. Isolating useInput in a child
// lets us mount it conditionally without breaking the rules of hooks — the
// same pattern as relay-view-input's InputCapture, but dashboard-owned so
// relay-view-input.tsx stays untouched (spec §8 / F4).
//
// Esc is forwarded as its own boolean (not `inputCh === ""`) because Ink
// collapses many non-printable keys (Esc, Left/Right arrows, Tab, PageUp,
// Home, etc.) to the same empty `inputCh`. Without this, Left/Right arrows
// in Inspector would silently bounce to Wall.
function DashInput(props: {
	onKey: (ev: KeyEv) => void;
	children: ReactNode;
}): ReactElement {
	useInput((inputCh, key) => {
		if (key.escape) return props.onKey({ escape: true });
		if (key.upArrow) return props.onKey({ upArrow: true });
		if (key.downArrow) return props.onKey({ downArrow: true });
		props.onKey({ key: inputCh });
	});
	return <>{props.children}</>;
}

export function DashboardApp(props: {
	node: ReactElement;
	onKey: (ev: KeyEv) => void;
}): ReactElement {
	const { isRawModeSupported } = useStdin();
	return isRawModeSupported ? (
		<DashInput onKey={props.onKey}>{props.node}</DashInput>
	) : (
		props.node
	);
}
