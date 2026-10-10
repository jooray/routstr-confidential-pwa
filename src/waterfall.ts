// A network-panel style timeline of one confidential request: one row per
// step, bars on a shared time axis, a vertical line where the request was sent
// (pre-armed work sits to its left) and one at the first token.

import type { TimingSpan } from "@routstr/confidential-web";

const LANE_LABEL: Record<TimingSpan["lane"], string> = {
  node: "node",
  "2pc": "2PC",
  proofs: "proofs",
  tls: "TLS",
  provider: "provider",
};

function fmt(ms: number): string {
  const a = Math.abs(ms);
  return a >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : a >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/** Axis label: compact, signed ("−10 s", "0", "+2.5 s", "+500 ms"). */
function tickLabel(ms: number): string {
  if (ms === 0) return "0";
  const sign = ms < 0 ? "−" : "+";
  const a = Math.abs(ms);
  return a >= 1000 ? `${sign}${+(a / 1000).toFixed(1)} s` : `${sign}${Math.round(a)} ms`;
}

function div(cls: string, style?: string, text?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (style) d.setAttribute("style", style);
  if (text !== undefined) d.textContent = text;
  return d;
}

/** Nice tick step for a range in ms (about `n` ticks). */
function tickStep(range: number, n: number): number {
  const raw = range / n;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

export function waterfall(spans: TimingSpan[], opts: { ttftMs?: number; numbers: boolean; large?: boolean }): HTMLElement {
  const root = div(`wf${opts.numbers ? " numbers" : ""}${opts.large ? " large" : ""}`);
  if (!spans.length) {
    root.append(div("muted", undefined, "No timing data."));
    return root;
  }
  const lo = Math.min(0, ...spans.map((s) => s.startMs));
  const hi = Math.max(0, ...spans.map((s) => s.endMs));
  const range = Math.max(hi - lo, 1);
  const pct = (ms: number) => `${(((ms - lo) / range) * 100).toFixed(3)}%`;

  // axis
  const axis = div("wf-row wf-axis");
  const axisTrack = div("wf-track");
  const step = tickStep(range, opts.large ? 12 : 7);
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Math.round(t));
  ticks.forEach((t, i) => {
    // skip labels that would collide with the edges; the grid line stays
    const edge = (t - lo) / range;
    const show = (opts.large || i % 2 === 0 || t === 0) && edge > 0.04 && edge < 0.96;
    axisTrack.append(div("wf-tick", `left:${pct(t)}`, show ? tickLabel(t) : ""));
  });
  axis.append(div("wf-label"), axisTrack);
  root.append(axis);

  const body = div("wf-body");
  for (const s of spans) {
    const row = div("wf-row");
    const label = div("wf-label", undefined, s.name);
    label.title = s.name;
    const track = div("wf-track");
    const dur = s.endMs - s.startMs;
    const bar = div(
      `wf-bar lane-${s.lane}${s.endMs <= 0 ? " before" : ""}`,
      `left:${pct(s.startMs)};width:max(2px, ${((dur / range) * 100).toFixed(3)}%)`,
    );
    bar.title = `${s.name}: ${fmt(dur)} (${fmt(s.startMs)} → ${fmt(s.endMs)} from sending)`;
    track.append(bar);
    if (opts.numbers) {
      const w = dur / range;
      if (w > 0.18) bar.append(div("wf-num-in", undefined, fmt(dur)));
      else {
        const right = (s.endMs - lo) / range > 0.75;
        track.append(
          div(
            "wf-num",
            right ? `right:calc(100% - ${pct(s.startMs)} + 4px)` : `left:calc(${pct(s.endMs)} + 4px)`,
            fmt(dur),
          ),
        );
      }
    }
    row.append(label, track);
    body.append(row);
  }
  // markers span the whole body
  const markers = div("wf-markers");
  for (const t of ticks) if (t !== 0) markers.append(div("wf-grid", `left:${pct(t)}`));
  const sent = div("wf-marker sent", `left:${pct(0)}`);
  sent.title = "request sent";
  markers.append(sent);
  if (opts.ttftMs !== undefined) {
    const ft = div("wf-marker ttft", `left:${pct(opts.ttftMs)}`);
    ft.title = `first token at ${fmt(opts.ttftMs)}`;
    markers.append(ft);
  }
  const markerLayer = div("wf-marker-layer");
  markerLayer.append(div("wf-label"), markers);
  body.append(markerLayer);
  root.append(body);

  const legend = div("wf-legend");
  const lanes = [...new Set(spans.map((s) => s.lane))];
  for (const l of lanes) {
    const item = div("wf-legend-item");
    item.append(div(`wf-swatch lane-${l}`), document.createTextNode(LANE_LABEL[l]));
    legend.append(item);
  }
  const sentKey = div("wf-legend-item");
  sentKey.append(div("wf-swatch-line sent"), document.createTextNode("request sent"));
  legend.append(sentKey);
  if (opts.ttftMs !== undefined) {
    const k = div("wf-legend-item");
    k.append(div("wf-swatch-line ttft"), document.createTextNode(`first token ${fmt(opts.ttftMs)}`));
    legend.append(k);
  }
  root.append(legend);
  return root;
}
