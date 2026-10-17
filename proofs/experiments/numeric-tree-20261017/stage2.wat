(module
 (type $0 (func (param i32 i32 i32 f64 f64 f64 f64) (result i32)))
 (type $1 (func (param i32 i32 i32 v128 v128 v128) (result v128)))
 (type $2 (func (param i32 i32 i32 i32 f64 f64 f64 f64) (result i32)))
 (type $3 (func (param i32 i32 i32 i32 f64 f64) (result i32)))
 (import "env" "memory" (memory $0 2 65536 shared))
 (export "countInRange" (func $numeric-kernels.as/countInRange))
 (export "countPointsInBox" (func $numeric-spatial.as/countPointsInBox))
 (export "memory" (memory $0))
 (func $numeric-spatial.as/treeBox (param $0 i32) (param $1 i32) (param $2 i32) (param $3 f64) (param $4 f64) (param $5 f64) (param $6 f64) (result i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 f64)
  local.get $1
  i32.eqz
  if
   loop $for-loop|0
    local.get $2
    local.get $7
    i32.gt_u
    if
     local.get $8
     local.get $5
     local.get $0
     local.get $7
     i32.const 3
     i32.shl
     i32.add
     local.tee $1
     f64.load
     local.tee $11
     f64.ge
     local.get $3
     local.get $11
     f64.le
     i32.and
     local.get $4
     local.get $1
     f64.load offset=8
     local.tee $11
     f64.le
     i32.and
     local.get $6
     local.get $11
     f64.ge
     i32.and
     i32.add
     local.set $8
     local.get $7
     i32.const 2
     i32.add
     local.set $7
     br $for-loop|0
    end
   end
   local.get $8
   return
  end
  i32.const 1
  local.get $1
  i32.const 5
  i32.mul
  i32.shl
  local.set $9
  loop $while-continue|0
   local.get $2
   if
    local.get $0
    local.get $7
    i32.const 2
    i32.shl
    i32.add
    i32.load
    local.get $1
    i32.const 1
    i32.sub
    local.get $2
    local.get $9
    local.get $2
    local.get $9
    i32.lt_u
    select
    local.tee $10
    local.get $3
    local.get $4
    local.get $5
    local.get $6
    call $numeric-spatial.as/treeBox
    local.get $8
    i32.add
    local.set $8
    local.get $2
    local.get $10
    i32.sub
    local.set $2
    local.get $7
    i32.const 1
    i32.add
    local.set $7
    br $while-continue|0
   end
  end
  local.get $8
 )
 (func $numeric-kernels.as/treeSums (param $0 i32) (param $1 i32) (param $2 i32) (param $3 v128) (param $4 v128) (param $5 v128) (result v128)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  local.get $1
  i32.eqz
  if
   loop $while-continue|0
    local.get $2
    local.get $6
    i32.sub
    i32.const 2
    i32.ge_u
    if
     local.get $5
     local.get $0
     local.get $6
     i32.const 3
     i32.shl
     i32.add
     v128.load
     local.tee $5
     local.get $3
     f64x2.ge
     local.get $5
     local.get $4
     f64x2.le
     v128.and
     i64x2.sub
     local.set $5
     local.get $6
     i32.const 2
     i32.add
     local.set $6
     br $while-continue|0
    end
   end
   local.get $5
   return
  end
  local.get $1
  i32.const 1
  i32.eq
  if
   loop $for-loop|1
    local.get $6
    local.get $2
    i32.const 5
    i32.shr_u
    i32.lt_u
    if
     local.get $0
     local.get $6
     i32.const 2
     i32.shl
     i32.add
     i32.load
     local.set $7
     i32.const 0
     local.set $1
     loop $while-continue|2
      i32.const 32
      local.get $1
      i32.sub
      i32.const 2
      i32.ge_u
      if
       local.get $5
       local.get $7
       local.get $1
       i32.const 3
       i32.shl
       i32.add
       v128.load
       local.tee $5
       local.get $3
       f64x2.ge
       local.get $5
       local.get $4
       f64x2.le
       v128.and
       i64x2.sub
       local.set $5
       local.get $1
       i32.const 2
       i32.add
       local.set $1
       br $while-continue|2
      end
     end
     local.get $6
     i32.const 1
     i32.add
     local.set $6
     br $for-loop|1
    end
   end
   local.get $5
   return
  end
  i32.const 1
  local.get $1
  i32.const 5
  i32.mul
  i32.shl
  local.set $8
  loop $while-continue|3
   local.get $2
   if
    local.get $0
    local.get $6
    i32.const 2
    i32.shl
    i32.add
    i32.load
    local.get $1
    i32.const 1
    i32.sub
    local.get $2
    local.get $8
    local.get $2
    local.get $8
    i32.lt_u
    select
    local.tee $7
    local.get $3
    local.get $4
    local.get $5
    call $numeric-kernels.as/treeSums
    local.set $5
    local.get $2
    local.get $7
    i32.sub
    local.set $2
    local.get $6
    i32.const 1
    i32.add
    local.set $6
    br $while-continue|3
   end
  end
  local.get $5
 )
 (func $numeric-spatial.as/countPointsInBox (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 f64) (param $5 f64) (param $6 f64) (param $7 f64) (result i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 f64)
  local.get $3
  i32.const 1
  i32.and
  if
   unreachable
  end
  local.get $3
  i32.eqz
  local.get $4
  local.get $6
  f64.gt
  i32.or
  local.get $5
  local.get $7
  f64.gt
  i32.or
  local.get $4
  local.get $4
  f64.ne
  i32.or
  local.get $5
  local.get $5
  f64.ne
  i32.or
  local.get $6
  local.get $6
  f64.ne
  i32.or
  local.get $7
  local.get $7
  f64.ne
  i32.or
  if
   i32.const 0
   return
  end
  local.get $3
  local.get $3
  i32.const 1
  i32.sub
  i32.const -32
  i32.and
  local.tee $10
  i32.sub
  local.set $3
  loop $for-loop|0
   local.get $3
   local.get $8
   i32.gt_u
   if
    local.get $9
    local.get $2
    local.get $8
    i32.const 3
    i32.shl
    i32.add
    local.tee $9
    f64.load
    local.tee $11
    local.get $4
    f64.ge
    local.get $6
    local.get $11
    f64.ge
    i32.and
    local.get $9
    f64.load offset=8
    local.tee $11
    local.get $5
    f64.ge
    i32.and
    local.get $7
    local.get $11
    f64.ge
    i32.and
    i32.add
    local.set $9
    local.get $8
    i32.const 2
    i32.add
    local.set $8
    br $for-loop|0
   end
  end
  local.get $10
  if (result i32)
   local.get $0
   local.get $1
   local.get $10
   local.get $4
   local.get $5
   local.get $6
   local.get $7
   call $numeric-spatial.as/treeBox
  else
   i32.const 0
  end
  local.get $9
  i32.add
 )
 (func $numeric-kernels.as/countInRange (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 f64) (param $5 f64) (result i32)
  (local $6 v128)
  (local $7 i32)
  (local $8 i32)
  (local $9 v128)
  (local $10 v128)
  local.get $3
  i32.eqz
  local.get $4
  local.get $5
  f64.gt
  i32.or
  local.get $4
  local.get $4
  f64.ne
  i32.or
  local.get $5
  local.get $5
  f64.ne
  i32.or
  if
   i32.const 0
   return
  end
  local.get $4
  f64x2.splat
  local.set $9
  local.get $5
  f64x2.splat
  local.set $10
  local.get $3
  i32.const 1
  i32.sub
  i32.const -32
  i32.and
  local.tee $7
  if (result v128)
   local.get $0
   local.get $1
   local.get $7
   local.get $9
   local.get $10
   v128.const i32x4 0x00000000 0x00000000 0x00000000 0x00000000
   call $numeric-kernels.as/treeSums
  else
   v128.const i32x4 0x00000000 0x00000000 0x00000000 0x00000000
  end
  local.set $6
  local.get $3
  local.get $7
  i32.sub
  local.set $0
  loop $while-continue|0
   local.get $0
   local.get $8
   i32.sub
   i32.const 2
   i32.ge_u
   if
    local.get $6
    local.get $2
    local.get $8
    i32.const 3
    i32.shl
    i32.add
    v128.load
    local.tee $6
    local.get $9
    f64x2.ge
    local.get $6
    local.get $10
    f64x2.le
    v128.and
    i64x2.sub
    local.set $6
    local.get $8
    i32.const 2
    i32.add
    local.set $8
    br $while-continue|0
   end
  end
  local.get $6
  i64x2.extract_lane 0
  i32.wrap_i64
  local.get $6
  i64x2.extract_lane 1
  i32.wrap_i64
  i32.add
  local.set $0
  local.get $3
  i32.const 1
  i32.and
  if (result i32)
   local.get $0
   local.get $4
   local.get $2
   local.get $3
   local.get $7
   i32.sub
   i32.const 1
   i32.sub
   i32.const 3
   i32.shl
   i32.add
   f64.load
   local.tee $4
   f64.le
   local.get $4
   local.get $5
   f64.le
   i32.and
   i32.add
  else
   local.get $0
  end
 )
)
