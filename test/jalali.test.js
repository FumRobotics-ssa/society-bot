import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatJalaliDate, gregorianToJalali, jalaliFirstWeekday, jalaliMonthLength,
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
