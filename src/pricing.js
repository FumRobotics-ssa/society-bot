const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export const DEFAULT_FUM_STUDENT_NUMBER_LENGTH = 10;

export function normalizeDigits(value = '') {
  return String(value).replace(/[۰-۹٠-٩]/g, digit => {
    const persian = PERSIAN_DIGITS.indexOf(digit);
    return String(persian >= 0 ? persian : ARABIC_DIGITS.indexOf(digit));
  });
}

export function configuredStudentNumberLength(value) {
  const raw = value == null ? '' : normalizeDigits(value).trim();
  if (!raw) return DEFAULT_FUM_STUDENT_NUMBER_LENGTH;
  if (!/^\d{1,2}$/.test(raw)) throw new Error('FUM_STUDENT_NUMBER_LENGTH must be a whole number from 1 to 20');
  const length = Number(raw);
  if (length < 1 || length > 20) throw new Error('FUM_STUDENT_NUMBER_LENGTH must be a whole number from 1 to 20');
  return length;
}

export function normalizeStudentNumber(value = '') {
  return normalizeDigits(value).trim();
}

export function isValidStudentNumber(value, exactLength = DEFAULT_FUM_STUDENT_NUMBER_LENGTH) {
  const number = normalizeStudentNumber(value);
  const requiredLength = exactLength == null ? DEFAULT_FUM_STUDENT_NUMBER_LENGTH : exactLength;
  return new RegExp(`^\\d{${requiredLength}}$`).test(number);
}

export function isFumStudent(profile = {}) {
  const value = profile?.is_fum_student;
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function resolveEventPricing(event, profile = {}, exactStudentNumberLength = null) {
  if (event?.pricing_mode === 'differentiated') {
    if (isFumStudent(profile)) {
      const studentNumber = normalizeStudentNumber(profile.student_number);
      if (!isValidStudentNumber(studentNumber, exactStudentNumberLength ?? DEFAULT_FUM_STUDENT_NUMBER_LENGTH)) {
        return { pricing_group: 'fum_student', unit_price: null, requires_student_number: true };
      }
      return { pricing_group: 'fum_student', unit_price: Number(event.fum_student_price || 0), requires_student_number: false };
    }
    return { pricing_group: 'general', unit_price: Number(event.price || 0), requires_student_number: false };
  }
  return {
    pricing_group: 'fixed',
    unit_price: event?.is_paid ? Number(event.price || 0) : 0,
    requires_student_number: false,
  };
}

export function pricingGroupLabel(group, { selfReported = true } = {}) {
  if (group === 'fum_student') return `تعرفهٔ دانشجوی فردوسی${selfReported ? ' (بر اساس خوداظهاری)' : ''}`;
  if (group === 'general') return 'تعرفهٔ عمومی';
  return 'قیمت یکسان برای همه';
}
