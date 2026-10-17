import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeOpenCvCspSafe } from '../scripts/build-paddle.mjs';

const original = await readFile(new URL('../node_modules/@techstark/opencv-js/dist/opencv.js', import.meta.url), 'utf8');
const adapted = makeOpenCvCspSafe(original);
function extract(source, start, end) {
  return source.slice(source.indexOf(`function ${start}(`), source.indexOf(`function ${end}(`));
}

test('CSP-safe OpenCV invokers preserve conversion, cleanup, return and argument checks', () => {
  for (const stacked of [true, false]) {
    const exercise = source => {
      const log = [];
      const create = vm.runInNewContext(`${extract(source, 'craftInvokerFunction', 'heap32VectorToArray')};craftInvokerFunction`, {
        makeLegalFunctionName: name => name.replaceAll('.', '_'),
        throwBindingError: message => { throw new Error(message); },
        new_: (constructor, args) => Reflect.construct(constructor, args),
        runDestructors: stack => { while (stack.length) stack.pop()(); },
      });
      const parameter = name => ({
        name,
        toWireType(stack, value) {
          log.push(`convert:${name}`);
          if (stack) stack.push(() => log.push(`destroy:${name}`));
          return value.value;
        },
        destructorFunction: stacked ? undefined : () => log.push(`destroy:${name}`),
      });
      const fn = create('Sample.run', [{ name: 'int', fromWireType: value => value + 1 }, parameter('this'), parameter('arg')], {},
        (target, instance, arg) => { log.push('invoke'); return target + instance + arg; }, 10);
      const result = fn.call({ value: 2 }, { value: 3 });
      assert.throws(() => fn.call({ value: 2 }), /expected 1 args/);
      return { result, log, arity: fn.length };
    };
    assert.deepEqual(exercise(adapted), exercise(original));
  }
});

test('CSP-safe OpenCV method callers preserve pointer offsets and returned wire values', () => {
  const exercise = source => {
    const log = [];
    const types = [{ name: 'number', isVoid: false, toWireType: (_stack, value) => value * 2 }, ...[4, 8].map((advance, i) => ({
      name: `arg${i}`, argPackAdvance: advance,
      readValueFromPointer: pointer => { log.push(pointer); return pointer; },
      deleteObject: value => log.push(`delete:${value}`),
    }))];
    const caller = vm.runInNewContext(`${extract(source, '__emval_get_method_caller', '__emval_get_property')};__emval_get_method_caller(3,0)`, {
      __emval_lookupTypes: () => types,
      __emval_addMethodCaller: fn => fn,
      makeLegalFunctionName: name => name.replace(/[^\w]/g, '_'),
      new_: (constructor, args) => Reflect.construct(constructor, args),
    });
    const handle = { offset: 7, sum(a,b) { return this.offset+a+b; } };
    return { result: caller(handle, 'sum', [], 100), log };
  };
  assert.deepEqual(exercise(adapted), exercise(original));
  assert.doesNotMatch(adapted, /new Function\s*\(|new_\(Function|\beval\s*\(/);
});
