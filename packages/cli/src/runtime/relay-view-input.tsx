import { useInput, useStdin } from "ink";
import type { ReactElement, ReactNode } from "react";
import { RelayView, type Viewport } from "./relay-view.js";
import type { RelayViewState } from "./relay-view-state.js";

type KeyEv = { upArrow?: boolean; downArrow?: boolean; key?: string };

// Mounted ONLY when raw mode is supported (real TTY). Isolating the
// useInput hook in its own component lets us conditionally render it
// without violating the rules of hooks. (ink 7.0.3 throws "Raw mode is
// not supported" on mount of any useInput component under non-TTY stdin,
// regardless of the isActive option — so gate at the tree level.)
function InputCapture(props: {
	onKey: (ev: KeyEv) => void;
	children: ReactNode;
}): ReactElement {
	useInput((inputCh, key) => {
		if (key.upArrow) return props.onKey({ upArrow: true });
		if (key.downArrow) return props.onKey({ downArrow: true });
		props.onKey({ key: inputCh });
	});
	return <>{props.children}</>;
}

export function RelayViewApp(props: {
	state: RelayViewState;
	viewport: Viewport;
	rows: number;
	cols: number;
	onKey: (ev: KeyEv) => void;
}): ReactElement {
	const { isRawModeSupported } = useStdin();
	const view = (
		<RelayView
			state={props.state}
			viewport={props.viewport}
			rows={props.rows}
			cols={props.cols}
		/>
	);
	return isRawModeSupported ? (
		<InputCapture onKey={props.onKey}>{view}</InputCapture>
	) : (
		view
	);
}
