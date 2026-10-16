"""Exact 80-group METHOD-v2 controller. SOURCE ONLY until separately approved.

There is intentionally no build/install/preparation command and no bypass flag.
Every prerequisite must already exist and match externally supplied trust pins.
"""
import sys
sys.dont_write_bytecode = True

import argparse
import datetime
import fcntl
import math
import os
from pathlib import Path
import platform
import signal
import shutil
import time

import bounded_process
from bounded_process import Supervisor, write
from headroom import effective_memory
from authentication import authenticate, inventory, read_json, reauthenticate, sha, verify_final_seal
from analyze import analyze, validate_report
from specification import (ALLOWANCES, CASE, CASE_SHA256, FINAL_RESERVE_SECONDS, MIN_AVAILABLE_BYTES,
                           METHOD_SHA256, PRIMARY, ROWS, RSS_LIMIT_BYTES, SEQUENCE, SEQUENCE_SHA256,
                           WHOLE_SECONDS, require)


class PhaseDeadline(TimeoutError):
    pass


def feasibility(remaining_seconds, node_seconds, bun_seconds):
    require(all(type(v) in (int,float) and math.isfinite(v) and v > 0 for v in (remaining_seconds,node_seconds,bun_seconds)),
            'invalid rehearsal/projection duration')
    projected = 2*36*(node_seconds+bun_seconds)+FINAL_RESERVE_SECONDS
    return {'remainingSeconds':remaining_seconds, 'nodeRehearsalSeconds':node_seconds, 'bunRehearsalSeconds':bun_seconds,
            'factor':2, 'processesPerEngine':36, 'finalReserveSeconds':FINAL_RESERVE_SECONDS,
            'requiredSeconds':projected, 'admitted':projected <= remaining_seconds,
            'basis':'entire supervisor-observed fresh rehearsal lifetime including polling/reaping'}


def config_for(group, binding, output, counts):
    arm = 'candidate' if group['arm'] == 'C' else 'baseline'
    root = binding['paths']['artifacts'][arm]
    return {'schemaVersion':1, **{key:group[key] for key in ('mode','engine','arm','block','processOrder')},
            'artifactRoot':str(root), 'sharedEntry':str(root/'dist/shared.js'), 'workerEntry':str(root/'dist/worker.js'),
            'output':str(output), 'bindingSHA256':binding['bindingSHA256'], 'caseSHA256':CASE_SHA256,
            'sequenceSHA256':SEQUENCE_SHA256,
            **({'counts':counts[group['engine']]} if group['mode'] in ('rehearsal','measurement') else {})}


def _identity(report, config):
    expected = {key:config[key] for key in ('mode','engine','arm','block','processOrder','bindingSHA256','caseSHA256','sequenceSHA256')}
    require(report.get('identity') == expected, 'driver identity does not match this single-study schedule')


def main(argv=None):
    started = time.monotonic()  # Before argument parsing, admission or authentication.
    started_unix = time.time()
    deadline, target_deadline = started+WHOLE_SECONDS, started+WHOLE_SECONDS-FINAL_RESERVE_SECONDS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binding', required=True, type=Path)
    parser.add_argument('--binding-sha256', required=True)
    parser.add_argument('--approval', required=True, type=Path)
    parser.add_argument('--approval-sha256', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(argv)
    output = args.output
    require(output.is_absolute() and output == output.resolve() and not output.exists(), 'fresh absolute output directory required; no retries')
    output.mkdir(parents=False)
    proof = Path(__file__).resolve().parent
    supervisor = Supervisor(output, [(proof,'$PERFORMANCE_PROOF'),(output,'$STUDY_EVIDENCE')])
    status = {'schemaVersion':1,'status':'incomplete','methodSHA256':METHOD_SHA256,'groupsExpected':80,'groupsStarted':0,'groupsComplete':0,
              'startedUnix':started_unix,'wholeStudySeconds':WHOLE_SECONDS,'finalReserveSeconds':FINAL_RESERVE_SECONDS,
              'performanceClaim':False,'requiresIndependentPerformanceAudit':True,'requiresSuccessfulControllerExit':True}
    phases, admissions, observations, calibration, counts, rehearsals = [],[],[],{},{},{}
    binding, lock, failure = None,None,None
    complete = False
    write(output/'status.json',status)
    write(output/'phases.json',phases)
    write(output/'commands.json',[])
    write(output/'headroom.json',[])

    def receipt(phase, begin, **extra):
        phases.append({'phase':phase,'elapsedSeconds':time.monotonic()-begin,'studyElapsedSeconds':time.monotonic()-started,**extra})
        write(output/'phases.json',phases)

    def checkpoint():
        write(output/'observations.json',{'schemaVersion':1,'complete':complete,'calibration':calibration,'observations':observations})
        write(output/'status.json',status)

    def alarm(_number,_frame):
        if supervisor.active is not None:
            supervisor.interrupted = signal.SIGALRM
        else:
            raise PhaseDeadline('whole study or target phase deadline')

    signal.signal(signal.SIGALRM,alarm)
    signal.setitimer(signal.ITIMER_REAL,max(.001,target_deadline-time.monotonic()))
    try:
        begin = time.monotonic()
        require(platform.system() == 'Linux' and platform.machine() == 'x86_64', 'hosted Linux x64 required')
        require(not os.environ.get('NODE_OPTIONS') and not os.environ.get('BUN_OPTIONS'), 'runtime tuning is forbidden')
        # Cooperative single-study lease; the separately approved host allocation
        # must independently exclude concurrent builds/tests/studies.
        lock = open('/tmp/native-reader-performance-exclusive.lock','a')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        binding = authenticate(args.binding,args.binding_sha256,args.approval,args.approval_sha256,proof)
        require(binding['approval'].get('exclusiveStudyHost') is True, 'exclusive host allocation must be explicitly approved')
        require(not output.is_relative_to(proof), 'evidence must be outside immutable proof source')
        for path in [*binding['paths']['artifacts'].values(),*binding['paths']['sources'].values(),binding['paths']['dependencies'],
                     binding['transport']['evidenceRoot']]:
            require(not output.is_relative_to(path) and not path.is_relative_to(output), 'evidence cannot overlap authenticated trees')
        for path in binding['transport']['inputFiles']:
            require(not Path(path).is_relative_to(output), 'evidence cannot contain authenticated transport inputs')
        # Exact original sanitized environment; no GC flags, subject hooks, shell,
        # runtime version groups, install/build commands, or replacement groups.
        require(bounded_process.CHILD_ENVIRONMENT == {'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8',
                    'CI':'1','NO_COLOR':'1','DO_NOT_TRACK':'1'}, 'sanitized environment changed')
        provenance = output/'prerequisites'
        provenance.mkdir()
        for source,name in [(args.binding,'binding.json'),(args.approval,'execution-approval.json'),
                            (Path(binding['manifest']['correctnessAuditPath']),'correctness-audit.json'),
                            (Path(binding['manifest']['correctnessTerminalReceiptPath']),'correctness-terminal-exit.json'),
                            (Path(binding['manifest']['baselineInventoryPath']),'baseline-sources.json'),
                            (Path(binding['manifest']['performanceReviewPath']),'implementation-audit.json'),
                            (Path(binding['manifest']['preparationReceiptPath']),'preparation.json'),
                            (Path(binding['manifest']['transportReceiptPath']),'transport.json'),
                            (Path(binding['manifest']['transportMethodPath']),'transport-method.json'),
                            (Path(binding['manifest']['readyInputInventoryPath']),'ready-inventory.json'),
                            (Path(binding['manifest']['methodPath']),'METHOD-v2.md'),
                            (Path(binding['manifest']['methodSealPath']),'METHOD-v2-SEAL.json')]:
            shutil.copyfile(source,provenance/name)
        shutil.copytree(binding['transport']['evidenceRoot'],provenance/'transport-evidence')
        correctness = Path(binding['manifest']['correctnessEvidenceRoot'])
        for name in ('inputs.json','outputs.json','commands.json','dependencies.json','status.json','cleanup.json','evidence-sha256.json'):
            shutil.copyfile(correctness/name,provenance/('correctness-'+name))
        write(output/'admission.json',{'schemaVersion':1,'bindingSHA256':args.binding_sha256,'approvalSHA256':args.approval_sha256,
              'methodSHA256':METHOD_SHA256,'caseSHA256':CASE_SHA256,'sequenceSHA256':SEQUENCE_SHA256,
              'runtimePaths':{name:str(path) for name,path in binding['paths']['runtimes'].items()},
              'runtimes':binding['inputs']['executables'],'sourceFiles':binding['inputs']['sourceFiles'],
              'builds':binding['outputs']['builds'],'importRootFiles':binding['importRootFiles'],'proofFiles':binding['proofFiles'],
              'buildPreparationCost':binding['preparation'],'artifactTransportCost':binding['transport']['receipt'],
              'correctnessCostSeconds':read_json(Path(binding['manifest']['correctnessEvidenceRoot'])/'status.json').get('elapsedSecondsForSafety'),
              'platform':{'system':platform.system(),'release':platform.release(),'machine':platform.machine(),
                          'processor':platform.processor(),'affinity':sorted(os.sched_getaffinity(0))},
              'environment':bounded_process.CHILD_ENVIRONMENT,'runtimeFlags':[], 'noConcurrentBuildTestStudy':True,
              'limits':{'minimumEffectiveAvailableBytes':MIN_AVAILABLE_BYTES,'sampledGroupRssBytes':RSS_LIMIT_BYTES,
                        'samplerSeconds':.05,'cleanupReserveSeconds':2,'hardAllocationCeiling':False}})
        write(output/'schedule.json',SEQUENCE)
        write(output/'case.json',CASE)
        receipt('source-authentication-and-admission',begin,passed=True)
        for group in SEQUENCE:
            require(not supervisor.interrupted and supervisor.active is None, 'interrupted or owned group not empty')
            begin = time.monotonic()
            # Expensive source/runtime/artifact checks and accounting are inside
            # the overall cap and outside target timing.
            reauthenticate(binding)
            require(time.monotonic()+group['wallSeconds'] <= target_deadline, 'next full group allowance does not fit before final reserve')
            accounting = effective_memory()
            admissions.append({'label':group['label'],'studyElapsedSeconds':time.monotonic()-started,'accounting':accounting})
            write(output/'headroom.json',admissions)
            require(accounting.get('cgroups'), 'resolvable nonempty cgroup memory accounting required')
            require(accounting['effectiveAvailableBytes'] >= MIN_AVAILABLE_BYTES, 'less than 2 GiB effective available memory')
            report_path = output/(group['label']+'-report.json')
            config_path = output/(group['label']+'-config.json')
            config = config_for(group,binding,report_path,counts)
            write(config_path,config)
            selected_driver = 'preflight.mjs' if group['mode'] == 'mechanism' else 'owner.mjs'
            command = [binding['paths']['runtimes'][group['engine']],proof/selected_driver,config_path]
            observation = {'group':group,'report':{},'authenticated':False,'counts':counts.get(group['engine']),
                           'configFile':config_path.name,'configSHA256':sha(config_path)}
            observations.append(observation)
            status['groupsStarted'] += 1
            checkpoint()
            launch_error = None
            command_receipt = None
            try:
                command_receipt = supervisor.run(group['label'],command,proof,target_deadline,group['wallSeconds'],RSS_LIMIT_BYTES)
            except BaseException as error:
                launch_error = error
            finally:
                # Keep every durable driver checkpoint, even for killed groups.
                if report_path.exists():
                    try:
                        report = read_json(report_path)
                        observation['report'] = report
                        observation['reportFile'] = report_path.name
                        observation['reportSHA256'] = sha(report_path)
                        _identity(report,config)
                        reauthenticate(binding)
                        observation['authenticated'] = True
                    except BaseException as error:
                        observation['authenticationFailure'] = type(error).__name__+': '+str(error)
                        launch_error = launch_error or error
                else:
                    launch_error = launch_error or ValueError('missing durable group report')
                checkpoint()
            if launch_error:
                raise launch_error
            results = validate_report(observation['report'],group,counts.get(group['engine']))
            require(command_receipt['leaderReaped'] and not command_receipt['descendantsAfterCleanup'], 'owned group cleanup incomplete')
            if group['mode'] == 'calibration':
                calibration[group['engine']] = results
                counts[group['engine']] = {row:results[row]['count'] for row in ROWS}
                write(output/'calibration.json',calibration)
                require(all(results[row]['qualified'] for row in PRIMARY), 'primary calibration did not attain 40–80 ms')
            if group['mode'] == 'rehearsal':
                rehearsals[group['engine']] = command_receipt['elapsedSecondsForSafety']
                write(output/'rehearsals.json',rehearsals)
                if len(rehearsals) == 2:
                    projection = feasibility(deadline-time.monotonic(),rehearsals['node'],rehearsals['bun'])
                    write(output/'feasibility.json',projection)
                    require(projection['admitted'], 'full-lifecycle rehearsal projection does not fit remaining study cap')
            status['groupsComplete'] += 1
            receipt(group['label'],begin,passed=True)
            checkpoint()
        require(len(observations) == len(supervisor.receipts) == status['groupsComplete'] == 80, 'incomplete fixed 80-group schedule')
        require(supervisor.active is None and all(r['leaderReaped'] and not r['descendantsAfterCleanup'] for r in supervisor.receipts),
                'owned-group cleanup missing')
        complete = True
    except BaseException as error:
        failure = error
        status['failure'] = {'type':type(error).__name__,'message':supervisor.display(str(error))}
        phases.append({'phase':'terminal-failure','studyElapsedSeconds':time.monotonic()-started,**status['failure']})
        write(output/'phases.json',phases)
    finally:
        # Reserve includes analysis, final full reauthentication, raw sealing and
        # cleanup receipts. No new group may start here, including on failure.
        signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
        try:
            begin = time.monotonic()
            if binding is not None:
                try:
                    reauthenticate(binding,full=True)
                except BaseException as error:
                    complete = False
                    failure = failure or error
                    status['finalAuthenticationFailure'] = str(error)
                    # A changed provenance tree cannot authenticate prior output.
                    for observation in observations:
                        observation['authenticated'] = False
            complete = bool(complete and not failure and supervisor.active is None and not supervisor.interrupted)
            checkpoint()
            result = analyze(observations,calibration,complete)
            complete = complete and result['screenComplete']
            write(output/'analysis.json',result)
            write(output/'cleanup.json',{'ownedGroupStillActive':supervisor.active is not None,'interrupted':supervisor.interrupted,
                  'commands':[{'label':r['label'],'leaderReaped':r['leaderReaped'],
                               'descendantsAfterCleanup':r['descendantsAfterCleanup'],'cleanupSignals':r['cleanupSignals']} for r in supervisor.receipts]})
            require(time.monotonic() < deadline, 'whole study cap expired before sealing')
            status.update(status='complete' if complete else 'incomplete',ownedGroupStillActive=supervisor.active is not None,
                          elapsedSecondsBeforeSeal=time.monotonic()-started,endedUnix=time.time(),
                          finalSealRequired=True,controllerExitCode=0 if complete else 1)
            checkpoint()
            receipt('analysis-final-authentication-cleanup',begin,passed=complete)
            seal = {'schemaVersion':1,'methodSHA256':METHOD_SHA256,'bindingSHA256':args.binding_sha256,
                    'caseSHA256':CASE_SHA256,'sequenceSHA256':SEQUENCE_SHA256,'status':status['status'],
                    'files':inventory(output)}
            write(output/'FINAL-SEAL.json',seal)
            seal_hash = sha(output/'FINAL-SEAL.json')
            verify_final_seal(output,seal_hash)
            require(time.monotonic() < deadline and supervisor.active is None, 'whole cap/cleanup failed after final seal')
            # Terminal stdout is retained by the external execution receipt;
            # it records verified seal identity and complete lifetime, avoiding
            # a self-referential raw-file digest or post-seal mutation.
            print(__import__('json').dumps({'status':status['status'],'finalSealSHA256':seal_hash,
                  'finalSealVerified':True,'elapsedSecondsForSafety':time.monotonic()-started,
                  'controllerExitCode':0 if complete else 1},allow_nan=False),flush=True)
        except BaseException as error:
            complete = False
            failure = failure or error
            # Preserve existing raw evidence. An unverified/incomplete seal is
            # never silently relabeled as a successful terminal result.
            print(__import__('json').dumps({'status':'incomplete','finalSealVerified':False,
                  'failureType':type(error).__name__,'elapsedSecondsForSafety':time.monotonic()-started,
                  'controllerExitCode':1},allow_nan=False),flush=True)
        finally:
            signal.setitimer(signal.ITIMER_REAL,0)
            if lock is not None:
                lock.close()
    return 0 if complete else 1


if __name__ == '__main__':
    raise SystemExit(main())
