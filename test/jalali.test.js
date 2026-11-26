import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatEventSchedule, formatJalaliDate, gregorianToJalali, jalaliFirstWeekday, jalaliMonthLength,
  jalaliTimeToIso, jalaliToGregorian, parseJalaliDate, tehranDateTime,
} from '../public/jalali.js';

test('Persian calendar converts known event dates and validates leap days', () => {
  assert.deepEqual(gregorianToJalali(2026, 11, 14), { year: 1405, month: 8, day: 23 });
  assert.deepEqual(jalaliToGregorian(1405, 8, 23), { year: 2026, month: 11, day: 14 });
  assert.equal(jalaliMonthLength(1403, 12), 30);
  assert.equal(jalaliMonthLength(1404, 12), 29);
  assert.throws(() => jalaliToGregorian(1404, 12, 30), /تاریخ شمسی/);
  assert.equal(jalaliFirstWeekday(1405, 8), 6);
  for (let year = 1400; year <= 1410; year++) {
    for (let month = 1; month <= 12; month++) {
      for (const day of [1, jalaliMonthLength(year, month)]) {
        const gregorian = jalaliToGregorian(year, month, day);
        assert.deepEqual(gregorianToJalali(gregorian.year, gregorian.month, gregorian.day), { year, month, day });
      }
    }
  }
});

test('Persian input round trips through Tehran time to UTC without device timezone', () => {
  const selected = parseJalaliDate('۱۴۰۵/۰۸/۲۳');
  assert.equal(formatJalaliDate(selected), '۱۴۰۵/۰۸/۲۳');
  assert.equal(jalaliTimeToIso(selected, '۱۲:۳۰'), '2026-11-14T09:00:00.000Z');
  assert.deepEqual(tehranDateTime('2026-11-14T09:00:00.000Z'), { year: 1405, month: 8, day: 23, hour: 12, minute: 30 });
  assert.throws(() => parseJalaliDate('۱۴۰۴/۱۲/۳۰'), /تاریخ شمسی/);
  assert.throws(() => jalaliTimeToIso(selected, '۲۵:۰۰'), /ساعت/);
});

test('event schedules repeat dates only across Tehran days and display significant minutes', () => {
  const start = '2026-12-03T12:30:00Z';
  assert.equal(formatEventSchedule(start, '2026-12-03T14:30:00Z'), '۱۲ آذر ۱۴۰۵، از ساعت ۱۶ تا ۱۸');
  assert.equal(formatEventSchedule(start, '2026-12-03T14:35:00Z'), '۱۲ آذر ۱۴۰۵، از ساعت ۱۶ تا ۱۸:۰۵');
  assert.equal(formatEventSchedule('2026-12-02T22:00:00Z', '2026-12-03T04:30:00Z'), '۱۲ آذر ۱۴۰۵، از ساعت ۱:۳۰ تا ۸');
  assert.equal(formatEventSchedule('2026-12-03T20:00:00Z', '2026-12-03T21:30:00Z'), 'از ۱۲ آذر ۱۴۰۵ ساعت ۲۳:۳۰ تا ۱۳ آذر ۱۴۰۵ ساعت ۱');
  assert.equal(formatEventSchedule(start, ''), '۱۲ آذر ۱۴۰۵، ساعت ۱۶');
  assert.equal(formatEventSchedule('', ''), '');
});
