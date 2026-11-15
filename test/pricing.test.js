import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configuredStudentNumberLength,
  isValidStudentNumber,
  normalizeStudentNumber,
  resolveEventPricing,
} from '../src/pricing.js';

test('FUM student number length defaults to ten, remains configurable, and accepts only digit strings', () => {
  assert.equal(configuredStudentNumberLength(), 10);
  assert.equal(configuredStudentNumberLength(null), 10);
  assert.equal(configuredStudentNumberLength('۸'), 8);
  assert.throws(() => configuredStudentNumberLength('21'), /from 1 to 20/);
  assert.equal(isValidStudentNumber('۰۰۱۲۳۴۵۶۷۸'), true);
  assert.equal(isValidStudentNumber('٠٠١٢٣٤٥٦٧٨'), true);
  assert.equal(isValidStudentNumber('001234567'), false);
  assert.equal(isValidStudentNumber('00123456789'), false);
  assert.equal(isValidStudentNumber('00123A5678'), false);
  assert.equal(normalizeStudentNumber('٠٠۱۲۳۴۵۶۷۸'), '0012345678');
});

test('pricing resolution treats other universities as general and incomplete FUM data as incomplete', () => {
  const event = { pricing_mode: 'differentiated', price: 1000, fum_student_price: 500 };
  assert.deepEqual(resolveEventPricing(event, { is_fum_student: false, is_student: true }), {
    pricing_group: 'general', unit_price: 1000, requires_student_number: false,
  });
  assert.equal(resolveEventPricing(event, { is_fum_student: true }, 10).requires_student_number, true);
  assert.deepEqual(resolveEventPricing(event, { is_fum_student: true, student_number: '0000123456' }, 10), {
    pricing_group: 'fum_student', unit_price: 500, requires_student_number: false,
  });
});
