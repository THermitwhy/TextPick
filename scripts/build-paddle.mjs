import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// OpenCV.js 4.10's embind generates names, calls and wire-type conversion wrappers.
// Use ordinary closures preserving conversion/destructor order, arity and return handling.
// This only changes JavaScript bindings; OpenCV WASM and model algorithms are untouched.
// Fail closed if the upstream generated source changes; never enable unsafe-eval.
export function makeOpenCvCspSafe(source) {
  const namedStart = source.indexOf('function createNamedFunction(name,body){');
  const namedEnd = source.indexOf('function extendError(', namedStart);
  const dynStart = source.indexOf('function makeDynCaller(dynCall){');
  const dynEnd = source.indexOf('var fp;', dynStart);
  const invokeStart = source.indexOf('function craftInvokerFunction(');
  const invokeEnd = source.indexOf('function heap32VectorToArray(', invokeStart);
  const methodStart = source.indexOf('function __emval_get_method_caller(');
  const methodEnd = source.indexOf('function __emval_get_property(', methodStart);
  if ([namedStart, namedEnd, dynStart, dynEnd, invokeStart, invokeEnd, methodStart, methodEnd].some(n => n < 0) || !source.slice(namedStart, namedEnd).includes('new Function') || !source.slice(dynStart, dynEnd).includes('new Function') || !source.slice(invokeStart, invokeEnd).includes('new_(Function') || !source.slice(methodStart, methodEnd).includes('new_(Function')) throw new Error('Unsupported OpenCV wrapper version');
  const edits = [
    [namedStart, namedEnd, 'function createNamedFunction(name,body){var fn=function(){return body.apply(this,arguments)};Object.defineProperty(fn,"name",{value:makeLegalFunctionName(name),configurable:true});return fn}'],
    [dynStart, dynEnd, 'function makeDynCaller(dynCall){var fn=function(){var args=Array.prototype.slice.call(arguments,0,signature.length-1);args.length=signature.length-1;return dynCall.apply(null,[rawFunction].concat(args))};Object.defineProperty(fn,"length",{value:signature.length-1});return fn}'],
    [invokeStart, invokeEnd, `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){
      var count=argTypes.length;
      if(count<2)throwBindingError('argTypes array size mismatch');
      var method=argTypes[1]!==null&&classType!==null;
      var stackNeeded=argTypes.slice(1).some(function(type){return type!==null&&type.destructorFunction===undefined});
      var fn=function(){
        if(arguments.length!==count-2)throwBindingError('function '+humanName+' called with '+arguments.length+' arguments, expected '+(count-2)+' args!');
        var destructors=stackNeeded?[]:null;
        var wired=[], types=[];
        if(method){wired.push(argTypes[1].toWireType(destructors,this));types.push(argTypes[1])}
        for(var i=0;i<count-2;i++){wired.push(argTypes[i+2].toWireType(destructors,arguments[i]));types.push(argTypes[i+2])}
        var result=cppInvokerFunc.apply(null,[cppTargetFunc].concat(wired));
        if(stackNeeded)runDestructors(destructors);
        else for(var i=0;i<types.length;i++)if(types[i].destructorFunction!==null)types[i].destructorFunction(wired[i]);
        if(argTypes[0].name!=='void')return argTypes[0].fromWireType(result);
      };
      Object.defineProperty(fn,'name',{value:makeLegalFunctionName(humanName),configurable:true});
      Object.defineProperty(fn,'length',{value:count-2});return fn;
    }`],
    [methodStart, methodEnd, `function __emval_get_method_caller(argCount,argTypes){
      var types=__emval_lookupTypes(argCount,argTypes), retType=types[0];
      return __emval_addMethodCaller(function(handle,name,destructors,args){
        var values=[], offset=0;
        for(var i=1;i<types.length;i++){values.push(types[i].readValueFromPointer(args+offset));offset+=types[i].argPackAdvance}
        var result=handle[name].apply(handle,values);
        for(var i=1;i<types.length;i++)if(types[i].deleteObject)types[i].deleteObject(values[i-1]);
        if(!retType.isVoid)return retType.toWireType(destructors,result);
      });
    }`],
  ];
  for (const [start, end, replacement] of edits.sort((a,b) => b[0]-a[0])) source = source.slice(0,start) + replacement + source.slice(end);
  if (/new Function\s*\(|new_\(Function|\beval\s*\(/.test(source)) throw new Error('OpenCV still contains dynamic execution');
  return source;
}

export async function buildPaddle() {
  const lock = JSON.parse(await readFile('models/paddle/models.lock.json', 'utf8'));
  for (const name of ['PP-OCRv5_mobile_det.tar', 'PP-OCRv5_mobile_rec.tar']) {
    const bytes = await readFile(`models/paddle/${name}`);
    if (createHash('sha256').update(bytes).digest('hex') !== lock.files[name]?.sha256) throw new Error(`Paddle model checksum mismatch: ${name}`);
  }
  await build({
    entryPoints: ['extension/paddle-worker.js'], outfile: 'dist/paddle-worker.js',
    bundle: true, format: 'esm', platform: 'browser', target: 'chrome116',
    alias: { 'onnxruntime-web': 'onnxruntime-web/wasm' },
    external: ['fs', 'path', 'crypto'],
    plugins: [{ name: 'opencv-csp', setup(plugin) {
      plugin.onLoad({ filter: /[\\/]opencv\.js$/ }, async ({ path }) => ({
        contents: makeOpenCvCspSafe(await readFile(path, 'utf8')), loader: 'js',
      }));
    } }],
  });
  await mkdir('dist/vendor/ort', { recursive: true });
  for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) await cp(`node_modules/onnxruntime-web/dist/${name}`, `dist/vendor/ort/${name}`);
  for (const [source, target] of [
    ['node_modules/@techstark/opencv-js/LICENSE', 'OpenCV-LICENSE'],
    ['node_modules/js-yaml/LICENSE', 'js-yaml-LICENSE'],
    ['node_modules/clipper-lib/clipper.js', 'clipper-lib-source-and-licenses.js'],
  ]) await cp(source, `dist/licenses/${target}`);
  const notice = 'PaddleOCR.js/models: Apache-2.0; ONNX Runtime: MIT; OpenCV.js: Apache-2.0.\nSee models/paddle/LICENSE and ONNX-Runtime-LICENSE; other dependency notices are in this directory.\nOpenCV embind createNamedFunction, makeDynCaller, craftInvokerFunction and __emval_get_method_caller were adapted at build time to use CSP-safe closures.\nSource transformation: scripts/build-paddle.mjs. Inference weights and algorithms are unchanged.\n';
  await writeFile('dist/licenses/PaddleOCR-NOTICE.txt', notice);
}
