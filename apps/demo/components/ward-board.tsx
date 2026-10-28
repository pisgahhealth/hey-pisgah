import { PAYER_LABEL, type BoardCase, type WardBoard } from "../src/lib/discovery.js";
import { hhmm } from "../src/lib/paths.js";

const W = 420;
const H = 80;
const PAD = 16;
const Y_HAPPENED = 32;
const Y_RECORDED = 64;

// Two clocks on one axis: the top row is when work happened, the bottom row is when it reached the record.
export function TwoClockTimeline({ c, span }: { c: BoardCase; span: { start: number; end: number } }) {
  const x = (m: number) => PAD + ((m - span.start) / (span.end - span.start)) * (W - PAD * 2);
  const hours: number[] = [];
  for (let h = span.start; h <= span.end; h += 120) hours.push(h);
  const later = c.milestones.filter((m) => m.recorded_at > m.occurred_at);
  return (
    <figure className="twoclock">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${c.milestones.length} recorded steps from ${hhmm(c.start)} to ${hhmm(c.end)}; ${later.length} recorded later than they happened`}>
        {hours.map((h) => (
          <g key={h}>
            <line x1={x(h)} x2={x(h)} y1={14} y2={H - 6} className="tc-hour" />
            <text x={x(h)} y={10} className="tc-hour-t" textAnchor="middle">{hhmm(h)}</text>
          </g>
        ))}
        <line x1={x(c.start)} x2={x(c.end)} y1={Y_HAPPENED} y2={Y_HAPPENED} className="tc-rail" />
        <line x1={x(c.start)} x2={x(c.end)} y1={Y_RECORDED} y2={Y_RECORDED} className="tc-rail" />
        {c.milestones.map((m) => (
          <g key={m.event_id}>
            <title>{`${m.label}: happened ${hhmm(m.occurred_at)}, recorded ${hhmm(m.recorded_at)}`}</title>
            <line x1={x(m.occurred_at)} x2={x(m.recorded_at)} y1={Y_HAPPENED} y2={Y_RECORDED} className={m.recorded_at > m.occurred_at ? "tc-link tc-later" : "tc-link"} />
            <circle cx={x(m.occurred_at)} cy={Y_HAPPENED} r={3.6} className="tc-happened" />
            <circle cx={x(m.recorded_at)} cy={Y_RECORDED} r={3.6} className={m.recorded_at > m.occurred_at ? "tc-recorded tc-later" : "tc-recorded"} />
          </g>
        ))}
      </svg>
      <figcaption className="sr-only">Top row: when it happened. Bottom row: when it was recorded.</figcaption>
    </figure>
  );
}

export function CaseCard({ c, span }: { c: BoardCase; span: { start: number; end: number } }) {
  return (
    <article className="case" data-case={c.case_id}>
      <header className="case-head">
        <span className="case-bed">{c.bed}</span>
        <span className="case-who">
          <b>{c.patient}</b>
          <span>{c.age} y, {c.sex} · {c.reason}</span>
        </span>
        <span className="tag">{PAYER_LABEL[c.payer] ?? c.payer}</span>
      </header>
      <div className="case-clock-labels" aria-hidden="true"><span>Happened</span><span>Recorded</span></div>
      <TwoClockTimeline c={c} span={span} />
      <details className="case-steps">
        <summary>{c.milestones.length} steps, {hhmm(c.start)} to {hhmm(c.end)}{c.entered_later ? ` · ${c.entered_later} recorded later` : ""}</summary>
        <table>
          <thead><tr><th scope="col">Step</th><th scope="col">Who</th><th scope="col">Happened</th><th scope="col">Recorded</th></tr></thead>
          <tbody>
            {c.milestones.map((m) => (
              <tr key={m.event_id} className={m.recorded_at > m.occurred_at ? "is-later" : ""}>
                <td>{m.label}</td><td>{m.role ?? ""}</td><td>{hhmm(m.occurred_at)}</td><td>{hhmm(m.recorded_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </article>
  );
}

export function WardBoardView({ board }: { board: WardBoard }) {
  const wards = [...new Set(board.cases.map((c) => c.ward))];
  return (
    <div className="board" data-board-cases={board.cases.length}>
      <div className="board-legend" aria-hidden="true">
        <span><i className="lg-happened" />When it happened</span>
        <span><i className="lg-recorded" />When it was recorded</span>
        <span><i className="lg-later" />Recorded later</span>
      </div>
      {wards.map((w) => (
        <section key={w} className="ward" aria-label={`Ward ${w}`}>
          <h3 className="ward-title">Ward {w} <span>{board.cases.filter((c) => c.ward === w).length} discharges</span></h3>
          <div className="case-grid">
            {board.cases.filter((c) => c.ward === w).map((c) => <CaseCard key={c.case_id} c={c} span={board.span} />)}
          </div>
        </section>
      ))}
      <p className="source-note">Source: committed discovery fixtures, <code>{board.source}</code>, as recorded.</p>
    </div>
  );
}
