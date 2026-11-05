"""Compare wasm-dis instruction bodies and call/global mappings, without timings.

Usage: python inspect-native-codegen.py BEFORE.wat AFTER.wat BEFORE.wasm AFTER.wasm
Produce each WAT with the pinned dependency's node_modules/binaryen/bin/wasm-dis.
This is a structural diagnostic, not a performance or semantic-equivalence proof.
"""
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def normalize(body):
    body = re.sub(r"^\(func \$\d+", "(func $SELF", body)
    body = re.sub(r"\(call \$\d+", "(call $CALLEE", body)
    return re.sub(r"\$global\$\d+", "$GLOBAL", body)


def module(path):
    text = path.read_text()
    # Zero-parameter start functions can put a newline immediately after $N.
    starts = list(re.finditer(r"^ \(func \$(\d+)(?=[\s)])", text, re.M))
    functions = {}
    for i, match in enumerate(starts):
        end = starts[i + 1].start() if i + 1 < len(starts) else text.rfind("\n)")
        functions[int(match[1])] = text[match.start():end].strip()
    exports = {name: int(index) for name, index in re.findall(r'\(export "([^"]+)" \(func \$(\d+)\)\)', text)}
    return {"functions": functions, "exports": exports, "start": int(re.search(r"\(start \$(\d+)\)", text)[1])}


def compare(before_wat, after_wat, before_wasm, after_wasm):
    before, after = module(before_wat), module(after_wat)
    mapping = {}
    changed_exports = []
    for name, old in before["exports"].items():
        new = after["exports"].get(name)
        if new is not None and normalize(before["functions"][old]) == normalize(after["functions"][new]):
            mapping[old] = new
        else:
            changed_exports.append(name)
    for old, new in [(before["start"], after["start"])]:
        if normalize(before["functions"][old]) == normalize(after["functions"][new]):
            mapping[old] = new
    groups = []
    for mod, used in [(before, set(mapping)), (after, set(mapping.values()))]:
        grouped = defaultdict(list)
        for index, body in mod["functions"].items():
            if index not in used:
                grouped[digest(normalize(body).encode())].append(index)
        groups.append(grouped)
    for key, old in groups[0].items():
        new = groups[1].get(key, [])
        if len(old) == len(new) == 1:
            mapping[old[0]] = new[0]

    call_mismatches, global_targets = [], defaultdict(set)
    for old, new in sorted(mapping.items()):
        left, right = before["functions"][old], after["functions"][new]
        calls_before = [int(value) for value in re.findall(r"\(call \$(\d+)", left)]
        calls_after = [int(value) for value in re.findall(r"\(call \$(\d+)", right)]
        if len(calls_before) != len(calls_after) or any(mapping.get(a) != b for a, b in zip(calls_before, calls_after)):
            call_mismatches.append({"before": old, "after": new, "callsBefore": calls_before, "callsAfter": calls_after})
        globals_before = [int(value) for value in re.findall(r"\$global\$(\d+)", left)]
        globals_after = [int(value) for value in re.findall(r"\$global\$(\d+)", right)]
        assert len(globals_before) == len(globals_after)
        for a, b in zip(globals_before, globals_after):
            global_targets[a].add(b)
    global_mapping = {key: sorted(value) for key, value in sorted(global_targets.items())}
    global_consistent = all(len(value) == 1 for value in global_mapping.values())
    if global_consistent:
        global_consistent = len({value[0] for value in global_mapping.values()}) == len(global_mapping)
    return {
        "description": "Structural comparison only; no demonstrated cause for scalar timing changes",
        "wasmSha256": {"before": digest(before_wasm.read_bytes()), "after": digest(after_wasm.read_bytes())},
        "watSha256": {"before": digest(before_wat.read_bytes()), "after": digest(after_wat.read_bytes())},
        "normalization": "own function name, call target index and mutable-global index; all other instruction text retained",
        "beforeFunctionCount": len(before["functions"]), "afterFunctionCount": len(after["functions"]),
        "matchedFunctionCount": len(mapping), "functionMapping": mapping,
        "changedOrMissingExports": changed_exports,
        "newExports": sorted(set(after["exports"]) - set(before["exports"])),
        "unmatchedBeforeFunctions": sorted(set(before["functions"]) - set(mapping)),
        "unmatchedAfterFunctions": sorted(set(after["functions"]) - set(mapping.values())),
        "callGraphMismatches": call_mismatches,
        "globalMapping": global_mapping, "consistentOneToOneGlobalMapping": global_consistent,
    }


if __name__ == "__main__":
    assert len(sys.argv) == 5, __doc__
    print(json.dumps(compare(*(Path(value) for value in sys.argv[1:])), indent=2))
