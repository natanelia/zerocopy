(
  printf '%s\n' 'Intentional failure for numeric workflow pipeline verification.'
  exit 23
) | tee "${PIPELINE_PROBE_OUTPUT:?Set PIPELINE_PROBE_OUTPUT}"
