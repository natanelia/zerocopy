"""One bounded hosted correctness/preparation pass; no timing subjects here."""
from pathlib import Path
import datetime
import json
import os
import platform
import shutil
import sys
import time
from host import ROOT, sha, read, write, check_pins, check_activation, inventory, native_elf, supervised

def main(group):
    if group not in ['arm','browsers']: raise ValueError('Fixed group required')
    if os.environ.get('GITHUB_RUN_ATTEMPT') != '1': raise ValueError('No rerun: only hosted attempt 1')
    started = time.monotonic(); budget = 240
    output = ROOT / 'results' / group
    output.mkdir(parents=True, exist_ok=True)
    if (output/'PREFLIGHT.json').exists() or (output/'RUNTIME.json').exists():raise FileExistsError('No preflight rerun')
    work = output / 'preflight'; work.mkdir()
    job_deadline=read(output/'JOB.json')['subjectsDeadlineEpoch']
    record = {'state':'running','group':group,'commands':[],'metadataCommands':[],'error':None,'startedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    launches=(work/'launches.jsonl').open('x')
    try:
        activation=check_activation()
        if read(output/'JOB.json')['activation']!=activation:raise ValueError('Job activation identity changed')
        pin_hash = check_pins(); protocol = read(ROOT / 'PROTOCOL.json'); limits=protocol['limits'][group]
        for variable in ['NODE_OPTIONS','BUN_OPTIONS','BUN_INSPECT','LD_PRELOAD','LD_LIBRARY_PATH','PLAYWRIGHT_DOWNLOAD_HOST','PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST','PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST','PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST','PLAYWRIGHT_HOST_PLATFORM_OVERRIDE','PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD','PLAYWRIGHT_NODEJS_PATH']:
            if variable in os.environ: raise ValueError('Inherited runtime override: ' + variable)
        arch = 'arm64' if platform.machine() in ['aarch64','arm64'] else 'x64' if platform.machine() in ['x86_64','amd64'] else platform.machine()
        if platform.system() != 'Linux' or arch != ('arm64' if group=='arm' else 'x64'): raise ValueError('Host architecture mismatch')
        cache = ROOT / 'browser-cache'
        os.environ['PLAYWRIGHT_BROWSERS_PATH'] = str(cache)
        # Use only the already frozen, separately installed validation dependency tree.
        for link, target in [(ROOT/'node_modules', ROOT/'toolchain/node_modules')]+[(ROOT/'arms'/arm/'node_modules',ROOT/'toolchain/node_modules') for arm in ['baseline','candidate']]:
            if link.exists() or link.is_symlink(): raise FileExistsError(str(link))
            link.symlink_to(os.path.relpath(target,link.parent),target_is_directory=True)
        def run(name, argv, cwd=ROOT, handshake=False, env=None, metadata=False, metadata_cap=14):
            remaining=min(budget-(time.monotonic()-started)-10,job_deadline-time.time()-10)
            if remaining<=4: raise TimeoutError('Preflight total cap')
            entry={'id':name,'receipt':str((work/(name+'.receipt.json')).relative_to(output)),
              'argv':argv,'cwd':str(cwd),'state':'started'}
            record['metadataCommands' if metadata else 'commands'].append(entry)
            launches.write(json.dumps({'event':'launch','metadata':metadata,**entry})+'\n');launches.flush();os.fsync(launches.fileno())
            receipt=supervised(argv,cwd,work/name,min(metadata_cap if metadata else limits['preflightSeconds'],remaining),limits['preflightRSSMiB'],handshake,env)
            entry['state']='passed'
            launches.write(json.dumps({'event':'finish','id':name,'state':'passed'})+'\n');launches.flush();os.fsync(launches.fileno())
            return receipt
        versions = {}; executables = {}; metadata_commands=[]
        for runtime, expected in [('node','v22.23.3'),('bun','1.4.2')]:
            binary = Path(shutil.which(runtime) or '').resolve(strict=True)
            command=[str(binary),'--version']
            receipt=run('metadata-'+runtime+'-version',command,metadata=True,metadata_cap=9)
            stdout=(work/('metadata-'+runtime+'-version.jsonl')).read_text()
            stderr=(work/('metadata-'+runtime+'-version.stderr')).read_text()
            versions[runtime]=stdout.strip()
            metadata_commands.append({'argv':command,'exitCode':receipt['exitCode'],'stdout':stdout,'stderr':stderr})
            if versions[runtime]!=expected: raise ValueError('Runtime version mismatch: '+runtime)
            executables[runtime]={'path':str(binary),'sha256':sha(binary.read_bytes()),'bytes':binary.stat().st_size,'version':expected}
        packages={}
        for package, expected in [('playwright','1.63.0'),('playwright-core','1.63.0'),('vitest','4.1.11'),('@vitest/browser','4.1.11'),('@vitest/browser-playwright','4.1.11')]:
            packages[package]=read(ROOT/'node_modules'/package/'package.json')['version']
            if packages[package]!=expected: raise ValueError('Package mismatch: '+package)
        browser_metadata=ROOT/'node_modules/playwright-core/browsers.json'
        if sha(browser_metadata.read_bytes())!='545d52f8382c391e605562c330e9c1c534a16045898203037a49bb8bd769a946': raise ValueError('Browser revisions changed')
        browsers={}
        if group=='arm':
            for runtime in ['node','bun']:
                run(runtime+'-public-corpus',[executables[runtime]['path'],'public-corpus.mjs','arms/baseline','arms/candidate',str(work/(runtime+'-semantic.json'))])
            for arm in ['baseline','candidate']:
                run(arm+'-worker-session',[executables['node']['path'],'proofs/worker-sessions.mjs'],ROOT/'arms'/arm)
        else:
            expected_versions={'chromium':'153.0.8010.12','firefox':'155.0','webkit':'26.6'}
            for engine in ['chromium','firefox','webkit']:
                for arm in ['baseline','candidate']:
                    run(engine+'-'+arm+'-sessions',[executables['bun']['path'],'--bun','node_modules/vitest/vitest.mjs','run','--config','browser.config.mjs','demo/sessions.browser.test.ts'],env={'SCREEN_BROWSER':engine,'SCREEN_ARM':arm})
                receipt=run(engine+'-probe',[executables['node']['path'],'browser.mjs','probe',engine,str(work/(engine+'-probe.json'))],handshake=True)
                probe=read(work/(engine+'-probe.json'))
                if probe['version']!=expected_versions[engine] or probe['playwrightVersion']!='1.63.0': raise ValueError('Browser version mismatch: '+engine)
                browsers[engine]={**probe,'ownedProcessInventory':receipt['observedProcesses']}
        run('metadata-os-packages',['dpkg-query','-W','-f=${Package}\t${Version}\t${Architecture}\n'],metadata=True)
        (work/'os-packages.txt').write_bytes((work/'metadata-os-packages.jsonl').read_bytes())
        memlimit=Path('/sys/fs/cgroup/memory.max')
        dependency_inventory=inventory(ROOT/'toolchain/node_modules')
        browser_inventory=inventory(cache) if group=='browsers' else []
        elf_inventory=native_elf(dependency_inventory+browser_inventory)
        for row in elf_inventory:
            if row['path'].endswith('.node') and row['machine']!=(183 if arch=='arm64' else 62):raise ValueError('Native dependency architecture mismatch')
        manifest={'schema':1,'group':group,'activation':activation,'arch':arch,'platform':platform.platform(),'kernel':platform.release(),
          'cpuinfo':Path('/proc/cpuinfo').read_text(),'cpuCount':os.cpu_count(),'meminfo':Path('/proc/meminfo').read_text(),
          'cgroupMemoryLimit':memlimit.read_text().strip() if memlimit.exists() else None,
          'runner':{key:os.environ.get(key) for key in ['ImageOS','ImageVersion','RUNNER_ARCH','RUNNER_OS','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_WORKFLOW_REF']},
          'executables':executables,'metadataCommands':metadata_commands,'packages':packages,'browsers':browsers,
          'dependencies':dependency_inventory,'browserFiles':browser_inventory,'nativeELF':elf_inventory,
          'protocolSHA256':sha((ROOT/'PROTOCOL.json').read_bytes()),'inputPinsSHA256':pin_hash,
          'preflightCommands':record['commands'],'metadataReceipts':record['metadataCommands'],'osPackagesSHA256':sha((work/'os-packages.txt').read_bytes()),
          'scope':'Recorded hosted environment. Executable hashes frozen before subjects; no hermetic-host or allocation claim.'}
        check_pins()
        if time.monotonic()-started>budget or time.time()>job_deadline: raise TimeoutError('Preflight total cap')
        write(output/'RUNTIME.json',manifest); record['runtimeManifestSHA256']=sha((output/'RUNTIME.json').read_bytes());record['state']='passed'
    except BaseException as error: record['state']='failed';record['error']=repr(error)
    finally:
        record['elapsedSeconds']=time.monotonic()-started;write(output/'PREFLIGHT.json',record);launches.close()
    if record['state']!='passed': raise SystemExit(1)

if __name__=='__main__': main(sys.argv[1])
