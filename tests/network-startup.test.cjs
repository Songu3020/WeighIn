const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const fs=require('node:fs'),os=require('node:os');
const {spawn,spawnSync}=require('node:child_process');
function startup(mode){const result=spawnSync(process.execPath,['--require',path.join(__dirname,'support/network-startup-hook.cjs'),
  path.resolve(__dirname,'../scripts/wait-for-local-network.cjs')],{encoding:'utf8',timeout:10000,
  env:{...process.env,WEIGHIN_STARTUP_UNIT_MODE:mode}});assert.ifError(result.error);return result;}
for(const mode of ['unhealthy','metadata-only'])test(`startup fails closed for ${mode} RPC`,()=>{
  const r=startup(mode);assert.equal(r.status,1);assert.match(r.stderr,/RPC readiness failed within 120s/);
  assert.doesNotMatch(r.stdout,/network is ready|Funding deployer/);
});
test('healthy RPC with persistent Friendbot failure does not report network readiness',()=>{
  const r=startup('funding-failure');assert.equal(r.status,1);assert.match(r.stderr,/Account readiness failed within 120s/);
  assert.doesNotMatch(r.stdout,/network is ready/);
});
test('startup reports readiness only after healthy RPC and account inclusion',()=>{
  const r=startup('ready');assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/confirmed in RPC/);assert.match(r.stdout,/network is ready/);
});

const MOCK_CONTAINER_ID='4f0c2a9e8b1d0123456789abcdef0123456789abcdef0123456789abcdef0123';
function mockStartupTools(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'weighin-network-startup-'));
  const dockerPath=path.join(directory,'docker');
  const nodePath=path.join(directory,'node');
  const logPath=path.join(directory,'docker.jsonl');
  fs.writeFileSync(dockerPath,`#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='ps'){
  if(process.env.MOCK_EXISTING!=='none')process.stdout.write('mock-container\\n');
}else if(args[0]==='inspect'){
  if(process.env.MOCK_INSPECT_FAILURE==='1')process.exit(1);
  process.stdout.write(process.env.MOCK_EXISTING==='owned'?'weighin-start-local-network\\n':'\\n');
}else if(args[0]==='run'){
  if(process.env.MOCK_RUN_ID!=='')process.stdout.write((process.env.MOCK_RUN_ID||'${MOCK_CONTAINER_ID}')+'\\n');
}else if(args[0]==='logs'){
  if(process.env.MOCK_LOGS_FAILURE==='1')process.exit(1);
  process.stdout.write('quickstart: friendbot rejected funding\\n');
}else if(args[0]==='stop'){
  if(process.env.MOCK_STOP_FAILURE==='1')process.exit(1);
}
`);
  fs.writeFileSync(nodePath,`#!${process.execPath}
if(process.argv[2]==='-e')process.exit(0);
if(process.env.MOCK_READINESS==='hang')setTimeout(()=>process.exit(1),1500);
else if(process.env.MOCK_READINESS==='fail'){process.stderr.write('Account readiness failed within 120s\\n');process.exit(1);}
else process.stdout.write('network is ready\\n');
`);
  fs.chmodSync(dockerPath,0o755);
  fs.chmodSync(nodePath,0o755);
  const readCalls=()=>fs.existsSync(logPath)?fs.readFileSync(logPath,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const env=extra=>({...process.env,...extra,PATH:`${directory}${path.delimiter}${process.env.PATH}`,MOCK_DOCKER_LOG:logPath});
  return {env,readCalls};
}

function runStartup(existing='none',extraEnv={}){
  const tools=mockStartupTools();
  const result=spawnSync('bash',[path.resolve(__dirname,'../scripts/start-local-network.sh')],{
    encoding:'utf8',timeout:10000,env:tools.env({...extraEnv,MOCK_EXISTING:existing})
  });
  assert.ifError(result.error);
  return {result,calls:tools.readCalls()};
}

test('startup replaces its owned disposable sidecar and labels the new container',()=>{
  const {result,calls}=runStartup('owned');
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.ok(calls.some(args=>args[0]==='rm'&&args.includes('-f')));
  const run=calls.find(args=>args[0]==='run');
  assert.ok(run);
  assert.ok(run.includes('io.weighin.managed-by=weighin-start-local-network'));
});

test('startup preserves an unowned name collision with actionable guidance',()=>{
  const {result,calls}=runStartup('unowned');
  assert.equal(result.status,1);
  assert.match(result.stderr,/not owned by this startup script and was left untouched/);
  assert.match(result.stderr,/WEIGHIN_REPLACE_UNOWNED_CONTAINER=1/);
  assert.equal(calls.some(args=>['stop','rm','run'].includes(args[0])),false);
});

test('startup replaces an unowned collision only with explicit authorization',()=>{
  const {result,calls}=runStartup('unowned',{WEIGHIN_REPLACE_UNOWNED_CONTAINER:'1'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.ok(calls.some(args=>args[0]==='rm'&&args.includes('-f')));
  assert.ok(calls.some(args=>args[0]==='run'));
});

test('startup rejects invalid replacement authorization',()=>{
  const {result,calls}=runStartup('unowned',{WEIGHIN_REPLACE_UNOWNED_CONTAINER:'true'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/WEIGHIN_REPLACE_UNOWNED_CONTAINER=1/);
  assert.equal(calls.some(args=>['stop','rm','run'].includes(args[0])),false);
});

test('startup leaves a collision untouched when Docker ownership inspection fails',()=>{
  const {result,calls}=runStartup('unowned',{MOCK_INSPECT_FAILURE:'1'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/Could not verify ownership.*leaving it untouched/);
  assert.equal(calls.some(args=>['stop','rm','run'].includes(args[0])),false);
});

test('readiness failure captures logs, then stops only the container this attempt started',()=>{
  const {result,calls}=runStartup('none',{MOCK_READINESS:'fail'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/readiness failed/);
  assert.match(result.stdout,/friendbot rejected funding/);
  const after=calls.slice(calls.findIndex(args=>args[0]==='run')+1);
  assert.deepEqual(after,[['logs',MOCK_CONTAINER_ID],['stop',MOCK_CONTAINER_ID]]);
});

test('a readiness failure leaves an existing owned container replaced, not resurrected',()=>{
  const {result,calls}=runStartup('owned',{MOCK_READINESS:'fail'});
  assert.equal(result.status,1);
  assert.deepEqual(calls.map(args=>args[0]),['ps','inspect','rm','run','logs','stop']);
  assert.equal(calls.filter(args=>args[0]==='stop').every(args=>args[1]===MOCK_CONTAINER_ID),true);
});

test('a failed cleanup is reported and never turns failed readiness into success',()=>{
  const {result,calls}=runStartup('none',{MOCK_READINESS:'fail',MOCK_STOP_FAILURE:'1'});
  assert.equal(result.status,1);
  assert.match(result.stderr,new RegExp(`could not stop container ${MOCK_CONTAINER_ID}; remove it with: docker rm -f ${MOCK_CONTAINER_ID}`));
  assert.ok(calls.some(args=>args[0]==='stop'));
});

test('missing logs do not prevent stopping the container',()=>{
  const {result,calls}=runStartup('none',{MOCK_READINESS:'fail',MOCK_LOGS_FAILURE:'1'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/could not capture logs/);
  assert.deepEqual(calls.at(-1),['stop',MOCK_CONTAINER_ID]);
});

test('successful readiness leaves the started container running',()=>{
  const {result,calls}=runStartup('none');
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(calls.some(args=>['logs','stop','rm'].includes(args[0])),false);
});

test('startup fails closed without touching any container when docker run reports no ID',()=>{
  const {result,calls}=runStartup('none',{MOCK_RUN_ID:''});
  assert.equal(result.status,1);
  assert.match(result.stderr,/did not report the new container ID/);
  assert.equal(calls.some(args=>['logs','stop','rm'].includes(args[0])),false);
});

test('termination while waiting for readiness still stops the started container',async()=>{
  const tools=mockStartupTools();
  const child=spawn('bash',[path.resolve(__dirname,'../scripts/start-local-network.sh')],{
    env:tools.env({MOCK_EXISTING:'none',MOCK_READINESS:'hang'})
  });
  let stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  await new Promise(resolve=>{
    const poll=setInterval(()=>{
      if(tools.readCalls().some(args=>args[0]==='run')){clearInterval(poll);resolve();}
    },20);
  });
  child.kill('SIGTERM');
  const status=await new Promise(resolve=>child.on('close',code=>resolve(code)));
  assert.equal(status,143,stderr);
  assert.deepEqual(tools.readCalls().slice(-2),[['logs',MOCK_CONTAINER_ID],['stop',MOCK_CONTAINER_ID]]);
});

test('flagship workflow cleanup stops only the owned startup container',()=>{
  const yaml=require('yaml');
  const workflow=yaml.parse(fs.readFileSync(path.resolve(__dirname,'../.github/workflows/flagship-proof.yml'),'utf8'));
  const step=workflow.jobs.proof.steps.find(item=>item.name==='Stop owned sidecar');
  assert.ok(step);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'weighin-cleanup-'));
  const dockerPath=path.join(directory,'docker'),logPath=path.join(directory,'docker.jsonl');
  fs.writeFileSync(dockerPath,`#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='ps'&&process.env.MOCK_OWNED==='1')process.stdout.write('mock-container\\n');
`);
  fs.chmodSync(dockerPath,0o755);
  for(const [owned,expectedStops] of [['0',0],['1',1]]){
    const result=spawnSync('bash',['-e','-o','pipefail','-c',step.run],{encoding:'utf8',timeout:10000,
      env:{...process.env,PATH:`${directory}${path.delimiter}${process.env.PATH}`,MOCK_OWNED:owned,MOCK_DOCKER_LOG:logPath}});
    assert.ifError(result.error);
    assert.equal(result.status,0,result.stdout+result.stderr);
    const calls=fs.readFileSync(logPath,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    assert.equal(calls.filter(args=>args[0]==='stop').length,expectedStops);
    assert.ok(calls[0].includes('label=io.weighin.managed-by=weighin-start-local-network'));
    fs.writeFileSync(logPath,'');
  }
});
