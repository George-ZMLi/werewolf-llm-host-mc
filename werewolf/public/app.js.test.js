import { describe, expect, it } from 'vitest';
import { renderDraftOverlay, renderPhaseBanner, renderSeatList } from './app.js';

describe('renderPhaseBanner', () => {
  it('renders the current phase name and remaining whole seconds', () => {
    const html = renderPhaseBanner('day_discussion', 42500);
    expect(html).toContain('Day Discussion');
    expect(html).toContain('>43s<');
  });

  it('clamps negative or missing remaining to 0s', () => {
    expect(renderPhaseBanner('night', -5000)).toContain('>0s<');
    expect(renderPhaseBanner('voting')).toContain('>0s<');
  });
});

describe('renderSeatList', () => {
  it('marks offline seats and highlights the acting seat', () => {
    const seats = [
      { seatId: 's0', name: 'A' },
      { seatId: 's1', name: 'B', offline: true },
    ];
    const html = renderSeatList(seats, 's0');
    const idxActing = html.indexOf('class="seat acting"');
    const idxOffline = html.indexOf('class="seat offline"');
    expect(idxActing).toBeGreaterThan(-1);
    expect(idxOffline).toBeGreaterThan(idxActing);
    expect(html).toContain('(offline)');
  });

  it('escapes names and renders an empty list safely', () => {
    const html = renderSeatList([{ seatId: 's0', name: '<script>' }], 's0');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(renderSeatList(null, null)).toContain('seat-list');
  });
});

describe('renderDraftOverlay', () => {
  it('renders the draft action in an editable textarea with confirm and reject', () => {
    const html = renderDraftOverlay({
      seatId: 's0',
      action: { action: 'target_player', targets: ['s2'] },
    });
    expect(html).toContain('s0');
    expect(html).toContain('target_player');
    expect(html).toContain('draft-confirm');
    expect(html).toContain('draft-reject');
    expect(html).toContain('draft-text');
  });
});