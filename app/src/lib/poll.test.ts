import { expect, test } from 'bun:test';
import { pollWhileVisible, type PageVisibility, type Timers } from './poll';

function rig(hidden = false) {
  const listeners = new Set<() => void>();
  const page = {
    hidden,
    addEventListener: (_: 'visibilitychange', l: () => void) => { listeners.add(l); },
    removeEventListener: (_: 'visibilitychange', l: () => void) => { listeners.delete(l); },
  };
  const running = new Map<number, () => void>();
  let next = 1;
  const timers: Timers = {
    set: run => { running.set(next, run); return next++; },
    clear: handle => { running.delete(handle as number); },
  };
  let loads = 0;
  const stop = pollWhileVisible(() => { loads++; }, 5_000, page as PageVisibility, timers);
  return {
    stop,
    loads: () => loads,
    timers: () => running.size,
    tick: () => running.forEach(run => run()),
    show: (visible: boolean) => { page.hidden = !visible; listeners.forEach(l => l()); },
    listeners: () => listeners.size,
  };
}

test('loads at once, then on every tick', () => {
  const r = rig();
  expect(r.loads()).toBe(1);
  r.tick();
  r.tick();
  expect(r.loads()).toBe(3);
});

test('a hidden page makes no calls, and a page shown again loads at once', () => {
  const r = rig();
  r.show(false);
  expect(r.timers()).toBe(0);
  r.tick();
  expect(r.loads()).toBe(1);
  r.show(true);
  expect(r.loads()).toBe(2);
  expect(r.timers()).toBe(1);
  r.show(true); // a repeated event must not start a second timer
  expect(r.timers()).toBe(1);
  expect(r.loads()).toBe(2);
});

test('a page opened in the background waits until it is shown', () => {
  const r = rig(true);
  expect(r.loads()).toBe(0);
  expect(r.timers()).toBe(0);
  r.show(true);
  expect(r.loads()).toBe(1);
});

test('stopping clears the timer and the listener', () => {
  const r = rig();
  r.stop();
  expect(r.timers()).toBe(0);
  expect(r.listeners()).toBe(0);
  r.show(true);
  expect(r.loads()).toBe(1);
});
