"""One finite screen. No retries, replacement children, or subject execution on import."""
import base64, hashlib, json, math, os, re, shutil, signal, subprocess, sys, tarfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
BASE = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'
BRANCH = 'proof/bulk-empty-partitions-screen-20261014'
RSS_LIMIT = 1073741824

def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def read(path): return json.loads(Path(path).read_text())

def write(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, indent=2, allow_nan=False) + '\n')

def inventory(folder, generated=False):
    found = {}
    for directory, dirs, files in os.walk(folder, followlinks=False):
        dirs[:] = [d for d in dirs if d not in ['node_modules', '.git'] and (generated or d != 'dist')]
        for name in files:
            p = Path(directory) / name
            relative = p.relative_to(folder)
            native = len(relative.parts) == 1 and p.suffix in ['.wasm', '.wat']
            is_generated = native or relative.parts[0] == 'dist'
            if is_generated != generated: continue
            assert not p.is_symlink(), str(p)
            found[relative.as_posix()] = {'sha256': sha(p), 'bytes': p.stat().st_size} if generated else sha(p)
    return dict(sorted(found.items()))

def signal_group(pid, sig):
    try: os.killpg(pid, sig)
    except ProcessLookupError: pass

def group_memory(group):
    rows = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit(): continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) != group: continue
            status = (path / 'status').read_text()
            values = {name: int(value) * 1024 for name, value in re.findall(r'^(VmRSS|VmHWM):\s+(\d+) kB$', status, re.M)}
            rows.append({'pid': int(path.name), **values})
        except (FileNotFoundError, ProcessLookupError): pass
    return rows

def authenticate_portable(folder, expected):
    core = (folder / 'persistent-core.wasm').read_bytes()
    graph, embedded = {}, []
    for path in (folder / 'dist').glob('*.js'):
        text = path.read_text()
        graph[path.name] = re.findall(r'(?:from\s*|import\s*)[\'"](\./[^\'"]+\.js)[\'"]', text)
        for match in re.finditer(r'function loadWasm\(\)\s*\{\s*const text = atob\("([A-Za-z0-9+/=]+)"\)', text):
            assert base64.b64decode(match.group(1), validate=True) == core, 'embedded core mismatch'
            embedded.append(path.name)
    assert embedded == [expected['embeddedFile']]
    pending, seen = ['shared.js'], set()
    while pending:
        name = pending.pop()
        if name in seen: continue
        assert name in graph
        seen.add(name)
        pending.extend(Path(dependency).name for dependency in graph[name])
    assert sorted(seen) == expected['sharedEntryReachableFiles']
    assert sha(folder / 'persistent-core.wasm') == expected['coreSha256']
    assert sha(folder / 'dist' / embedded[0]) == expected['embeddedFileSha256']
    return expected

def recover_child(config, path):
    """Only durable validated-complete events can supply partial-study endpoints."""
    if path.exists(): return read(path)
    row={**config,'complete':False,'validatedEndpoints':[],'startup':{},'cases':{},'validation':{'startup':[],'cases':{}}}
    events=Path(str(path)+'.events.jsonl')
    if events.exists():
        for line in events.read_text().splitlines():
            try: event=json.loads(line)
            except json.JSONDecodeError: break
            if event['event']=='preflight':
                for key in ['q','clockReadingsNs','resolution']: row[key]=event[key]
            elif event['event']=='startup-complete':
                row['startup']=event['startup']; row['validation']['startup']=event['validation']; row['validatedEndpoints']+=['import','constructor','firstSetMany']
            elif event['event']=='case-complete':
                name=event['name']; row['cases'][name]=event['result']; row['validation']['cases'][name]=event['validation']; row['validatedEndpoints'].append(name)
    row['recoveredFromDurableEvents']=True
    return row

class Run:
    def __init__(self, root, epoch):
        self.root, self.start = root, epoch['monotonic']
        self.preparation_end, self.study_end, self.end = self.start + 120, self.start + 840, self.start + 900
        self.active, self.interrupted = None, None
        self.receipts, self.sources, self.generated, self.rows = [], {}, {}, []
        self.env = {**{k:os.environ[k] for k in ['PATH','HOME','TMPDIR','LANG','LC_ALL','TZ'] if k in os.environ}, 'CI':'1', 'NODE_OPTIONS':'', 'BUN_OPTIONS':''}
        for name in ['NODE_PATH', 'BULK_INPUT_RUNTIME', 'BULK_INPUT_REPORT']: self.env.pop(name, None)
        self.result = {'complete': False, 'base': BASE, 'branch': BRANCH, 'epoch': epoch, 'caps': {'preparation':120,'children':20,'childRssBytes':RSS_LIMIT,'study':900}, 'failureHistory': {'firstCorrectnessRun':38638756598,'status':'failed structural checker; retained unchanged','successfulSuccessor':38641407273}}
        self.plan = read(HERE/'SCHEDULE.json')
        artifact=root/'artifact'; artifact.mkdir()
        for name in ['children','logs']:
            (artifact/name).mkdir(); (root/name).symlink_to(artifact/name,target_is_directory=True)
        for name in ['progress.jsonl','command-receipts.json','source-inventories.json','generated-inventories.json','executables.json','rows.json','frozen-counts.json','schedule-status.json','analysis.json','hosted-result.json','host.json']:
            (root/name).symlink_to(artifact/name)
        write(root/'schedule-status.json',[{**x,'status':'unrun'} for x in self.plan])
        write(root/'hosted-result.json',self.result)
        shutil.copytree(HERE,artifact/'inputs')
        shutil.copyfile(REPO/'.github/workflows/bulk-empty-partitions-screen.yml',artifact/'workflow.yml')

    def event(self, event):
        event = {**event, 'elapsedSeconds': time.monotonic() - self.start}
        with (self.root / 'progress.jsonl').open('a') as f: f.write(json.dumps(event) + '\n')
        print(json.dumps(event), flush=True)

    def interrupted_by(self, signum, frame):
        self.interrupted = signum
        if self.active is not None: signal_group(self.active.pid, signal.SIGKILL)

    def check_inputs(self):
        for arm, expected in self.sources.items(): assert inventory(self.root / arm) == expected, 'source changed: ' + arm
        for arm, expected in self.generated.items(): assert inventory(self.root / arm, True) == expected, 'generated bytes changed: ' + arm
        for name, expected in read(HERE / 'INPUT-SHA256.json').items(): assert sha(HERE / name) == expected, 'proof input changed: ' + name

    def command(self, label, argv, cwd, deadline, cap=None, rss_limit=None):
        assert not self.interrupted, 'interrupted before command'
        started = time.monotonic()
        limit = min(deadline, started + cap) if cap else deadline
        assert limit > started, 'phase budget exhausted before ' + label
        logs = self.root / 'logs'; logs.mkdir(exist_ok=True)
        receipt = {'label':label,'argv':[str(x) for x in argv],'started':started,'capSeconds':cap,'effectiveCapSeconds':limit-started,'rssLimitBytes':rss_limit,'peakObservedGroupRss':0,'peakObservedProcessHwm':0,'seenPids':[],'cleanupSignals':[]}
        self.receipts.append(receipt); write(self.root / 'command-receipts.json', self.receipts)
        self.event({'event':'command-start','label':label})
        with (logs / (label + '.stdout')).open('xb') as out, (logs / (label + '.stderr')).open('xb') as err:
            child = subprocess.Popen(receipt['argv'], cwd=cwd, env=self.env, stdout=out, stderr=err, start_new_session=True)
            self.active = child; receipt['ownedProcessGroup'] = child.pid
            reason = None; seen = set()
            while True:
                exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if exited:
                    # WNOWAIT keeps the leader identity reserved while descendants are cleaned.
                    if time.monotonic() > limit: reason = reason or 'wall cap exceeded (terminal poll)'
                    break
                memory = group_memory(child.pid)
                seen.update(p['pid'] for p in memory)
                group_rss = sum(p.get('VmRSS', 0) for p in memory)
                hwm = max([p.get('VmHWM', 0) for p in memory] or [0])
                receipt['peakObservedGroupRss'] = max(receipt['peakObservedGroupRss'], group_rss)
                receipt['peakObservedProcessHwm'] = max(receipt['peakObservedProcessHwm'], hwm)
                if self.interrupted: reason = reason or 'signal interrupted'
                if time.monotonic() >= limit: reason = reason or 'wall cap exceeded'
                if rss_limit and max(group_rss, hwm) > rss_limit: reason = reason or 'RSS cap exceeded'
                if reason and not receipt['cleanupSignals']:
                    signal_group(child.pid, signal.SIGKILL); receipt['cleanupSignals'].append('SIGKILL original group: ' + reason)
                if reason and time.monotonic() > limit + 2: raise RuntimeError('original child failed to reap after kill: ' + label)
                time.sleep(min(.02, max(.001, limit - time.monotonic())))
        descendants = lambda: [p for p in group_memory(child.pid) if p['pid'] != child.pid]
        leftover = bool(descendants())
        if leftover:
            signal_group(child.pid, signal.SIGKILL); receipt['cleanupSignals'].append('SIGKILL descendants before leader reap')
            stop = min(self.end, time.monotonic() + 1)
            while descendants() and time.monotonic() < stop: time.sleep(.01)
        remains = bool(descendants())
        # Clear all signal authority before the one reap that releases this PID.
        self.active = None
        pid, status, usage = os.wait4(child.pid, 0)
        child.returncode = os.waitstatus_to_exitcode(status)
        receipt['wait4MaxRssBytes'] = usage.ru_maxrss * 1024
        if rss_limit and receipt['wait4MaxRssBytes'] > rss_limit: reason = reason or 'RSS cap exceeded (terminal high water)'
        receipt.update({'exitCode':child.returncode,'failure':reason,'seconds':time.monotonic()-started,'seenPids':sorted(seen),'leftoverGroup':leftover,'groupAfterCleanup':remains,'leaderReapedAfterCleanup':True,'interruptedSignal':self.interrupted})
        for stream in ['stdout','stderr']:
            p = logs / (label + '.' + stream); receipt[stream] = {'sha256':sha(p),'bytes':p.stat().st_size}
        self.active = None; write(self.root / 'command-receipts.json', self.receipts)
        self.event({'event':'command-end',**receipt})
        assert not reason and child.returncode == 0 and not leftover and not receipt['groupAfterCleanup'] and not self.interrupted, 'command failed; no retry: ' + label
        assert time.monotonic() <= deadline, 'phase budget exhausted at ' + label
        return receipt

    def prepare(self):
        self.check_inputs()
        assert os.environ.get('GITHUB_RUN_ATTEMPT')=='1' and os.environ.get('GITHUB_REF')=='refs/heads/'+BRANCH
        assert self.result['epoch']['runId']==os.environ.get('GITHUB_RUN_ID') and self.result['epoch']['attempt']==os.environ.get('GITHUB_RUN_ATTEMPT')
        assert 0<=time.monotonic()-self.start<=120,'invalid or exhausted workflow epoch'
        write(self.root/'host.json',{'uname':list(os.uname()),'cpuinfo':Path('/proc/cpuinfo').read_text(),'meminfo':Path('/proc/meminfo').read_text(),'affinity':sorted(os.sched_getaffinity(0)),'runId':os.environ['GITHUB_RUN_ID'],'attempt':os.environ['GITHUB_RUN_ATTEMPT'],'runner':{k:os.environ.get(k) for k in ['RUNNER_OS','RUNNER_ARCH','ImageOS','ImageVersion']}})
        for label, args in [('proof-head',['rev-parse','HEAD']),('proof-parent',['rev-parse','HEAD^'])]:
            self.command(label,['git',*args],REPO,self.preparation_end,5)
        self.result['proofHead'] = (self.root/'logs/proof-head.stdout').read_text().strip()
        assert (self.root/'logs/proof-parent.stdout').read_text().strip() == BASE
        assert self.result['proofHead']==os.environ['GITHUB_SHA'], 'proof is not triggering SHA'
        pins = read(HERE/'SOURCE-PINS.json')
        archive=self.root/'node-v22.16.0-linux-x64.tar.xz'
        self.command('official-node-download',['curl','--fail','--location','--silent','--show-error','--output',archive,'https://nodejs.org/download/release/v22.16.0/node-v22.16.0-linux-x64.tar.xz'],self.root,self.preparation_end,30)
        assert sha(archive)=='f4cb75bb036f0d0eddf6b79d9596df1aaab9ddccd6a20bf489be5abe9467e84e'
        self.command('official-node-extract',['tar','-xJf',archive,'-C',self.root],self.root,self.preparation_end,10)
        node=self.root/'node-v22.16.0-linux-x64/bin/node'
        assert sha(node) == pins['engines']['Node']['sha256']
        toolchain = self.root/'toolchain'; shutil.copytree(HERE/'toolchain',toolchain)
        self.env['PATH'] = str(node.parent) + os.pathsep + self.env['PATH']
        self.command('locked-dependencies',[node,node.parent.parent/'lib/node_modules/npm/bin/npm-cli.js','ci','--ignore-scripts','--no-audit','--no-fund'],toolchain,self.preparation_end,40)
        bun = (toolchain/'node_modules/@oven/bun-linux-x64/bin/bun').resolve()
        assert sha(bun) == pins['engines']['Bun']['sha256']
        self.engines = {'Node':node,'Bun':bun}; self.env['PATH'] = str(bun.parent)+os.pathsep+self.env['PATH']
        for engine, executable in self.engines.items():
            self.command(engine+'-version',[executable,'--version'],toolchain,self.preparation_end,5)
            assert (self.root/f'logs/{engine}-version.stdout').read_text().strip().lstrip('v') == pins['engines'][engine]['version']
        write(self.root/'executables.json',{e:{'path':str(p),'sha256':sha(p),'bytes':p.stat().st_size,'version':pins['engines'][e]['version']} for e,p in self.engines.items()})
        self.command('archive-exact-main',['git','archive','--format=tar',BASE,'-o',self.root/'main.tar'],REPO,self.preparation_end,5)
        baseline = self.root/'baseline'; baseline.mkdir()
        with tarfile.open(self.root/'main.tar') as tar: tar.extractall(baseline,filter='data')
        expected = read(HERE/'baseline-sources.json'); assert len(expected)==502 and inventory(baseline)==expected
        shutil.copytree(baseline,self.root/'candidate')
        self.command('apply-fixed-candidate',['git','apply','-p1',HERE/'candidate.patch'],self.root/'candidate',self.preparation_end,5)
        candidate = {**expected,'persistent-core.as.ts':pins['sourceSha256']['candidate/persistent-core.as.ts']}
        assert inventory(self.root/'candidate') == candidate
        self.sources = {'baseline':expected,'candidate':candidate}
        write(self.root/'source-inventories.json',self.sources)
        for arm in self.sources:
            folder = self.root/arm
            (folder/'node_modules').symlink_to(toolchain/'node_modules',target_is_directory=True)
            for p in [*folder.glob('*.wasm'),*folder.glob('*.wat')]: p.unlink()
            self.command(arm+'-native-build',[node,'scripts/build-wasm.mjs'],folder,self.preparation_end,25)
            self.command(arm+'-portable-build',[bun,'scripts/build-browser.ts'],folder,self.preparation_end,10)
            expected_generated = read(HERE/(arm+'-generated.json'))
            assert inventory(folder,True) == expected_generated, 'fresh generated output differs: '+arm
            self.generated[arm] = expected_generated
            authenticate_portable(folder,read(HERE/'portable-authentication.json')[arm])
            consumer = self.root/'consumers'/arm; (consumer/'node_modules').mkdir(parents=True)
            (consumer/'node_modules/zerocopy').symlink_to(folder,target_is_directory=True)
            for name in ['child.mjs','protocol.mjs']: shutil.copyfile(HERE/name,consumer/name)
        self.check_inputs(); write(self.root/'generated-inventories.json',self.generated)
        assert len(self.plan)==36
        self.result['preparationSeconds'] = time.monotonic()-self.start
        assert time.monotonic() <= self.preparation_end, 'preparation cap exceeded'

    def child(self, spec, counts):
        self.check_inputs()
        consumer=self.root/'consumers'/spec['arm']
        assert (consumer/'node_modules/zerocopy').resolve()==(self.root/spec['arm']).resolve()
        for name in ['child.mjs','protocol.mjs']: assert sha(consumer/name)==sha(HERE/name),'consumer driver changed'
        config = {**spec,'counts':counts,'armRoot':str(self.root/spec['arm'])}
        folder = self.root/'children'; folder.mkdir(exist_ok=True)
        path = folder/(spec['id']+'.json'); write(folder/(spec['id']+'.config.json'),config)
        try:
            self.command(spec['id'],[self.engines[spec['engine']],self.root/'consumers'/spec['arm']/'child.mjs',folder/(spec['id']+'.config.json'),path],self.root/'consumers'/spec['arm'],self.study_end,20,RSS_LIMIT)
            row = read(path)
            assert row['complete'] and all(row[k]==v for k,v in config.items()), 'child output identity'
            assert row['retainedArenas']==9
            self.rows.append(row)
            self.check_inputs()
            if spec['kind']=='observation':
                mate = next((r for r in self.rows if r['kind']=='observation' and r['engine']==spec['engine'] and r['repetition']==spec['repetition'] and r['arm']!=spec['arm']),None)
                if mate:
                    assert row['validation']==mate['validation'], 'paired endpoint divergence'
                    assert all(row['cases'][k]['sink']==mate['cases'][k]['sink'] for k in counts), 'paired sink divergence'
        except BaseException as error:
            row=next((r for r in self.rows if r['id']==spec['id']),None)
            if row is None: row=recover_child(config,path); self.rows.append(row)
            row['childReportedComplete']=row['complete']; row['complete']=False; row['parentFailure']={'error':repr(error),'receiptLabel':spec['id'],'capOrProcessFailure':self.receipts[-1].get('failure')}
            raise
        finally:
            write(self.root/'rows.json',self.rows)
            write(self.root/'schedule-status.json',[{**x,'status':next(('complete' if r['complete'] else 'failed' for r in self.rows if r['id']==x['id']),'unrun')} for x in self.plan])

    def study(self):
        fixture=read(HERE/'FIXTURE.json'); aliases={'large':'Large','dense16':'Dense16','empty':'Empty','one':'One','four':'Four','read':'Read'}
        g0={aliases.get(k,k):v for k,v in fixture['calibrationStartingCounts'].items()}
        gmax={aliases.get(k,k):v for k,v in fixture['fixedMaximumCounts'].items()}
        for spec in self.plan[:4]: self.child(spec,g0)
        frozen={}
        for name in g0:
            proposals=[row['cases'][name]['proposal'] for row in self.rows]
            assert all(isinstance(p['proposed'],int) and p['proposed']>=g0[name] for p in proposals)
            frozen[name]={'G':min(gmax[name],max(p['proposed'] for p in proposals)),'Gmax':gmax[name],'proposals':proposals}
        write(self.root/'frozen-counts.json',frozen)
        self.result['frozenCountsSha256']=sha(self.root/'frozen-counts.json')
        for spec in self.plan[4:]:
            assert sha(self.root/'frozen-counts.json')==self.result['frozenCountsSha256']
            self.child(spec,{k:v['G'] for k,v in frozen.items()})
        self.result['complete']=True

    def reconcile(self):
        write(self.root/'rows.json',self.rows)
        write(self.root/'hosted-result.json',self.result)
        if hasattr(self,'engines'):
            # The final five seconds belong to cleanup/preservation, inside the same 60-second window.
            self.command('reconcile',[self.engines['Node'],HERE/'summarize.mjs',self.root],HERE,self.reconciliation_end-5,55)
        self.check_inputs()

    def preserve(self):
        artifact=self.root/'artifact'; artifact.mkdir(exist_ok=True)
        for arm in ['baseline','candidate']:
            if not (self.root/arm).exists(): continue
            folder=artifact/'generated'/arm
            for relative in inventory(self.root/arm,True):
                assert time.monotonic()<self.reconciliation_end,'reconciliation/preservation budget exhausted'
                target=folder/relative; target.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(self.root/arm/relative,target)
                assert sha(target)==sha(self.root/arm/relative),'preserved bytes differ'

def terminal_analysis(run, valid):
    path=run.root/'analysis.json'
    if not path.exists(): return
    analysis=read(path)
    analysis['studyValid']=bool(valid and analysis['studyComplete'])
    analysis['eligibleForSeparatelyReviewedFollowOn']=bool(analysis['studyValid'] and analysis['primaryQualified'] and not analysis['regressionVeto'])
    analysis['pendingFinalIntegrity']=False
    analysis['terminalControllerComplete']=bool(valid)
    write(path,analysis)

def main():
    root=Path(sys.argv[1]).resolve(); root.mkdir()
    run=Run(root,read(sys.argv[2])); run.phase='preparation'
    def alarm(signum=None, frame=None):
        if run.active is not None: signal_group(run.active.pid,signal.SIGKILL)
        if run.phase!='reconciliation':
            failed_phase=run.phase; run.phase='reconciliation'
            run.reconciliation_end=min(run.end,time.monotonic()+60)
            signal.setitimer(signal.ITIMER_REAL,max(.001,run.reconciliation_end-time.monotonic()))
            raise TimeoutError(failed_phase+' deadline exhausted')
        # Hard terminal stop; all raw logs already live in artifact/. Cleanup is not claimed.
        run.result.update({'complete':False,'deadlineExceeded':True,'seconds':time.monotonic()-run.start,'hardStop':True,'activeGroupKilled':run.active.pid if run.active else None,'cleanupVerified':False,'artifactManifestStale':True})
        try: terminal_analysis(run,False)
        except BaseException: run.result['analysisInvalidOrMissing']=True
        write(root/'hosted-result.json',run.result)
        os._exit(124)
    def arm(deadline):
        if deadline<=time.monotonic(): alarm()
        signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
    signal.signal(signal.SIGALRM,alarm)
    for sig in [signal.SIGTERM,signal.SIGINT]: signal.signal(sig,run.interrupted_by)
    try:
        arm(run.preparation_end); run.prepare()
        run.phase='study'; arm(run.study_end); run.study()
    except BaseException as error: run.result.update({'complete':False,'error':repr(error)})
    finally:
        run.phase='reconciliation'
        run.reconciliation_end=min(getattr(run,'reconciliation_end',run.end),run.end,time.monotonic()+60)
        arm(run.reconciliation_end)
        if run.active is not None:
            owned=run.active
            signal_group(owned.pid,signal.SIGKILL)
            stop=min(run.reconciliation_end,time.monotonic()+1)
            while not os.waitid(os.P_PID,owned.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) and time.monotonic()<stop: time.sleep(.01)
            descendants=[p for p in group_memory(owned.pid) if p['pid']!=owned.pid]
            run.result['terminalCleanup']={'ownedGroup':owned.pid,'killedBeforeReap':True,'remainingDescendants':descendants}
            # No numeric group may be signalled after the leader's identity is released.
            run.active=None
            pid,status,usage=os.wait4(owned.pid,os.WNOHANG)
            if pid: owned.returncode=os.waitstatus_to_exitcode(status)
            else: run.result['cleanupError']='killed original leader not yet reaped'
        try: run.reconcile()
        except BaseException as error: run.result.update({'complete':False,'reconciliationError':repr(error)})
        try:
            run.preserve(); run.check_inputs()
            terminal_analysis(run,run.result['complete'])
            artifact=root/'artifact'
            manifest={}
            # The terminal record binds this manifest after every other integrity write.
            exclusions=['ARTIFACT-SHA256.json','hosted-result.json']
            for path in sorted(artifact.rglob('*')):
                if path.is_file() and path.relative_to(artifact).as_posix() not in exclusions:
                    assert time.monotonic()<run.reconciliation_end,'terminal integrity budget exhausted'
                    manifest[path.relative_to(artifact).as_posix()]=sha(path)
            write(artifact/'ARTIFACT-SHA256.json',manifest)
            run.result['artifactManifestSha256']=sha(artifact/'ARTIFACT-SHA256.json')
            run.result['artifactManifestExcludes']=exclusions
        except BaseException as error:
            run.result.update({'complete':False,'terminalIntegrityError':repr(error),'artifactManifestStale':True})
            terminal_analysis(run,False)
        run.result['seconds']=time.monotonic()-run.start
        if time.monotonic()>=run.reconciliation_end: alarm()
        write(root/'hosted-result.json',run.result)
        print(json.dumps(run.result),flush=True)
        signal.setitimer(signal.ITIMER_REAL,0)
    return 0 if run.result['complete'] else 1

if __name__=='__main__': raise SystemExit(main())
