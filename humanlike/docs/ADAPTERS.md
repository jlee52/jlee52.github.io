# Adapters: motion capture and other sources

Every adapter produces the same signals of the profile (`PROFILE.md`); the analyses do not depend on where
the data came from. Minari datasets with the profile need no adapter. The web app converts on the fly;
`humanlike convert` writes the result as a Minari dataset with the profile, so that it can be shared and
evaluated like any other. Positions are converted to metres; strides, speeds and gait cycles are then
computed with one definition for every source (`humanlike.gait`).

```bash
humanlike convert <adapter> <input> mylab/name-v0 --name NAME [options]   # a Minari dataset
humanlike validate mylab/name-v0    # which analyses the data support, and why not the others
humanlike evaluate mylab/name-v0 -o results/
```

| adapter | input | arrays it provides |
|---|---|---|
| `csv` | one CSV per rollout, or one CSV with a `rollout` column | any profile signal, by column name |
| `c3d` | C3D motion capture (Vicon, Qualisys, Motion Analysis, ...) | pelvis and feet from markers; foot GRFs from the force plates of an instrumented treadmill |
| `bvh` | BVH animation or motion-capture export | pelvis and feet by forward kinematics |
| `mimickit` | MimicKit / Isaac Gym steering rollouts | everything, at the physics rate |
| `curated` | the manuscript's curated rollouts | pelvis, feet, foot strikes |

## CSV

Columns are the profile signal names (PROFILE.md) with an axis or index suffix, for example
`time, pelvis_pos_x, pelvis_pos_y, pelvis_pos_z, left_foot_pos_x, ..., right_grf_z,
sagittal_angles_hip, sagittal_angles_knee, sagittal_angles_ankle, joint_torque_0, ...`.
`pelvis_x`, `lfoot_x`, `rfoot_x` (and `left_foot_x`, ...) are accepted for the core arrays. Without a
`time` column give `--fs`; lengths in other units: `--units mm`. Other column names can be mapped in
Python: `convert(path, name, columns={"pelvis_pos": ["PX", "PY", "PZ"]})`.

```bash
humanlike convert csv runs/ mylab/mypolicy-v0 --name MyPolicy --fs 50 --mass 70
```

## C3D

Each file is one rollout, grouped by the subject name stored in the file. Defaults follow Plug-in Gait:
pelvis = mean of LASI, RASI, LPSI, RPSI (or SACR); feet = LHEE, RHEE. Gaps up to 0.1 s are filled and
the longest complete stretch is kept. Foot strikes are detected from the markers, as for simulations
(`events="c3d"` uses the file's Foot Strike events instead).

```bash
humanlike convert c3d session/ mylab/s01-v0 --name S01                                  # over ground
humanlike convert c3d tm.c3d mylab/s01-tm-v0 --name S01 --treadmill-speed auto --mass 78   # treadmill
```

Treadmill trials are moved into over-ground coordinates by the belt travel (`--treadmill-speed` in m/s,
or `auto`, estimated from the feet in stance), and their force plates give the GRF of each foot (each
loaded plate assigned to the nearest foot). Over-ground force plates are left out because they cover a
few steps only. Without centre-of-mass data the kinetic analysis integrates the GRF, as for the human
reference. The reader (`humanlike.adapters.c3d_reader`) is plain numpy: Intel, DEC and MIPS files,
integer and floating-point storage; markers, analog channels, forces and centres of pressure agree with
ezc3d.

## BVH

The pelvis (Hips, Pelvis, ...) and feet (LeftFoot, LeftAnkle, ...) are found by name, ignoring prefixes
such as `mixamorig:`; give `pelvis=`, `left_foot=`, `right_foot=` otherwise. BVH is usually y-up
(default `--up y`); the unit is guessed from the pelvis height (`--units auto`) or given.

```bash
humanlike convert bvh clips/ mylab/clips-v0 --name Animation
```

## From Python

```python
from humanlike.adapters import from_arrays          # any simulator: build the rollouts from arrays
from humanlike.adapters.c3d import convert
ds = convert("tm.c3d", "S01", treadmill_speed="auto", mass_kg=78)
```
