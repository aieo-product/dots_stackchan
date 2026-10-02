import { afterEach, expect, test } from 'vitest';
import { PythonOpenJtalkSidecar } from '../src/tts/sidecar.js';
const workers: PythonOpenJtalkSidecar[] = [];
afterEach(() => { for (const worker of workers.splice(0)) worker.dispose(); });
function worker(script: string, requestTimeoutMs = 1000): PythonOpenJtalkSidecar {
 const sidecar = new PythonOpenJtalkSidecar({ command: process.execPath,
  args: ['--input-type=module', '-e', script], startupTimeoutMs: 1000, requestTimeoutMs });
 workers.push(sidecar); return sidecar;
}
const ready = 'console.log(JSON.stringify({ready:true}));';
const input = "import {createInterface} from 'node:readline'; const lines=createInterface({input:process.stdin});";
test('sidecar ready, request IDs, response, provider error and disposal without Python in CI', async () => {
 const sidecar = worker(ready + input + `lines.on('line',line=>{const {id,text}=JSON.parse(line); console.log(JSON.stringify(text==='bad'?{id,error:true}:{id,phones:['k','o']}));});`);
 await sidecar.start();
 expect(await sidecar.phonemize('test')).toEqual(['k', 'o']);
 await expect(sidecar.phonemize('bad')).rejects.toThrow('could not read');
 sidecar.dispose(); await expect(sidecar.phonemize('test')).rejects.toThrow('stopped');
});
test('request abort and timeout clean pending work', async () => {
 const sidecar = worker(ready + input, 20); await sidecar.start();
 const controller = new AbortController();
 const pending = sidecar.phonemize('test', controller.signal);
 await Promise.resolve(); await Promise.resolve(); controller.abort();
 await expect(pending).rejects.toThrow('interrupted');
 await expect(sidecar.phonemize('test')).rejects.toThrow('timed out');
});
test('malformed response rejects outstanding requests', async () => {
 const sidecar = worker(ready + input + `lines.on('line',()=>console.log('invalid'));`);
 await sidecar.start(); await expect(sidecar.phonemize('test')).rejects.toThrow();
});
test('missing executable fails startup clearly', async () => {
 const sidecar = new PythonOpenJtalkSidecar({ command: './missing-tts-command', startupTimeoutMs: 100 });
 workers.push(sidecar); await expect(sidecar.start()).rejects.toThrow('unavailable');
});
