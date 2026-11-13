// Persian calendar dates in the UI are converted with the browser's Intl calendar.
// Stored event times remain UTC ISO timestamps so existing records keep working.
const DAY_MS = 86400000;
const persianDay = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
  timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
});
const tehranClock = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
  timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const faDigits = '۰۱۲۳۴۵۶۷۸۹';

export const jalaliMonths = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
];
export const persianNumber = value => String(value).replace(/\d/g, digit => faDigits[Number(digit)]);
export const latinNumber = value => String(value).replace(/[۰-۹٠-٩]/g, digit => {
  const fa = faDigits.indexOf(digit);
  return fa >= 0 ? String(fa) : String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit));
});

function parts(formatter, value) {
  const result = {};
  for (const part of formatter.formatToParts(value)) {
    if (['year', 'month', 'day', 'hour', 'minute', 'second'].includes(part.type)) result[part.type] = Number(part.value);
  }
  return result;
}

export function gregorianToJalali(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) throw new RangeError('تاریخ معتبر نیست');
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) throw new RangeError('تاریخ معتبر نیست');
  const converted = parts(persianDay, date);
  return { year: converted.year, month: converted.month, day: converted.day };
}

export function jalaliToGregorian(year, month, day) {
  if (![year, month, day].every(Number.isInteger) || year < 1200 || year > 1700 || month < 1 || month > 12 || day < 1 || day > 31) throw new RangeError('تاریخ شمسی معتبر نیست');
  if (day > (month <= 6 ? 31 : 30)) throw new RangeError('تاریخ شمسی معتبر نیست');
  // Approximate Nowruz, then use Intl itself to find the exact Gregorian day.
  // The search covers year-to-year and leap-day differences without a second calendar rule.
  const approximate = Date.UTC(year + 621, 2, 20) + ((month - 1) * 30 + day - 1) * DAY_MS;
  for (let delta = -14; delta <= 14; delta++) {
    const date = new Date(approximate + delta * DAY_MS);
    const converted = parts(persianDay, date);
    if (converted.year === year && converted.month === month && converted.day === day) {
      return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    }
  }
  throw new RangeError('تاریخ شمسی معتبر نیست');
}

export function jalaliMonthLength(year, month) {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError('ماه معتبر نیست');
  if (month <= 6) return 31;
  if (month <= 11) return 30;
  try { jalaliToGregorian(year, 12, 30); return 30; } catch { return 29; }
}

export function parseJalaliDate(value) {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(latinNumber(value).trim());
  if (!match) throw new RangeError('تاریخ شمسی را از تقویم انتخاب کنید');
  const [year, month, day] = match.slice(1).map(Number);
  jalaliToGregorian(year, month, day);
  return { year, month, day };
}

export function formatJalaliDate({ year, month, day }) {
  return persianNumber(`${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`);
}

function tehranParts(date) { return parts(tehranClock, date); }

export function tehranDateTime(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError('زمان رویداد معتبر نیست');
  const local = tehranParts(date);
  return {
    ...gregorianToJalali(local.year, local.month, local.day),
    hour: local.hour, minute: local.minute,
  };
}

export function jalaliTimeToIso({ year, month, day }, time) {
  const match = /^(\d{2}):(\d{2})$/.exec(latinNumber(time || ''));
  if (!match) throw new RangeError('ساعت شروع را وارد کنید');
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new RangeError('ساعت شروع معتبر نیست');
  const gregorian = jalaliToGregorian(year, month, day);
  const wallTime = Date.UTC(gregorian.year, gregorian.month - 1, gregorian.day, hour, minute);
  let utc = wallTime;
  for (let i = 0; i < 3; i++) {
    const local = tehranParts(new Date(utc));
    const offset = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - utc;
    utc = wallTime - offset;
  }
  const check = tehranParts(new Date(utc));
  if (check.year !== gregorian.year || check.month !== gregorian.month || check.day !== gregorian.day || check.hour !== hour || check.minute !== minute) throw new RangeError('این ساعت در روز انتخاب شده معتبر نیست');
  return new Date(utc).toISOString();
}

export function jalaliFirstWeekday(year, month) {
  const gregorian = jalaliToGregorian(year, month, 1);
  return (new Date(Date.UTC(gregorian.year, gregorian.month - 1, gregorian.day)).getUTCDay() + 1) % 7;
}
