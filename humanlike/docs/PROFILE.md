# Humanlike locomotion profile 1.0

The benchmark does not define a file format. It defines a **profile**: the signals a locomotion data set
provides, their names, shapes, units and sign conventions, and the metadata the analyses need. The
profile is carried by an existing community format, as BIDS conventions are carried by NIfTI, TSV and
JSON files. The first mapping is **Minari** (Farama Foundation; HDF5 or Arrow), the dataset standard of
Gymnasium-based reinforcement learning. Motion capture enters through the C3D, BVH and CSV adapters
(`ADAPTERS.md`) and is converted to Minari datasets with the profile.

## Signals

Sampled at one rate `fs` per data set; positions in a right-handed world frame with the vertical axis
`up`; the walking direction is found from the data.

| signal | shape | unit | required | capability | meaning |
|---|---|---|---|---|---|
| `pelvis_pos` | [T,3] | m | yes | core | pelvis (or root) position, a proxy of the centre of mass |
| `left_foot_pos` | [T,3] | m | yes | core | left foot position (ankle or foot body origin) |
| `right_foot_pos` | [T,3] | m | yes | core | right foot position |
| `pelvis_vel` | [T,3] | m/s | no | core | pelvis velocity; differentiated from pelvis_pos if absent |
| `joint_torque` | [T,J] | N m | no | energetics | actuated joint torques (generalized forces) |
| `joint_vel` | [T,J] | rad/s | no | energetics | matching joint velocities |
| `sagittal_angles` | [T,3] | deg | no | sagittal | hip, knee, ankle sagittal angles of one leg (dataset.sagittal_side), + = flexion / dorsiflexion |
| `left_grf` | [T,3] | N | no | kinetics | floor force on the left foot, world frame |
| `right_grf` | [T,3] | N | no | kinetics | floor force on the right foot, world frame |
| `com_pos` | [T,3] | m | no | kinetics | whole-body centre of mass; the pelvis is used if absent |
| `com_vel` | [T,3] | m/s | no | kinetics | centre-of-mass velocity; differentiated from com_pos if absent |
| `sagittal_moments` | [T,3] | N m | no | joint_kinetics | hip, knee, ankle sagittal joint moments of the sagittal_angles leg, + = flexion / dorsiflexion |
| `sagittal_powers` | [T,3] | W | no | joint_kinetics | matching joint powers; moment x angular velocity of sagittal_angles if absent |
| `left_heel_strike`, `right_heel_strike` | [T] | bool | no | core | foot-strike marks; detected from the feet if absent |

Conventions: ground reaction forces are the forces of the floor on the foot; sagittal angles, moments
and powers are those of one leg (`sagittal_side`), positive for flexion / dorsiflexion; strides, speeds
and gait cycles are computed by the package with one definition for every data set (`humanlike.gait`).

## Metadata

| key | level | required | meaning |
|---|---|---|---|
| `fs` | data set | yes | rate of the profile signals (Hz) |
| `up` | data set | no (default `z`) | vertical axis |
| `mass_kg` | data set | for energetics and kinetics | body mass |
| `leg_length_m` | data set | no | hip joint centre to sole; dimensionless kinetics (Hof 1996) |
| `sagittal_side` | data set | no (default `left`) | leg of the sagittal signals; reference foot of the sagittal and kinetic analyses |
| `name`, `kind`, `simulator`, `skeleton` | data set | no | description |
| `group` | rollout | no | unit of replication of the feedback signature (session, subject) |
| `commanded_speed` | rollout | no | target speed (m/s) |
| `fell` | rollout | no | the agent fell; the rollout is excluded |
| `skip_s` | rollout | no | initial seconds to discard (start-up transient) |

## What the data allow

| capability | signals | metadata | analyses |
|---|---|---|---|
| core | pelvis_pos, left_foot_pos, right_foot_pos | - | events, gait_summary, gait_scaling, foot_placement, feedback |
| energetics | joint_torque, joint_vel | subject.mass_kg | energetics |
| sagittal | sagittal_angles | - | sagittal |
| kinetics | left_grf, right_grf | subject.mass_kg | gait_phases, kinetic_principles |
| joint_kinetics | sagittal_angles, sagittal_moments | subject.mass_kg | kinetic_principles (joint-work predictions) |

## Minari mapping

| profile | Minari |
|---|---|
| data set | a Minari dataset (one model, or one group of human subjects) |
| data-set metadata | `metadata.json` → `"humanlike_profile": {"profile": "humanlike-locomotion", "version": "1.0", "fs", "samples_per_step", "up", "mass_kg", ...}` |
| rollout | an episode |
| rollout metadata | episode metadata: `group`, `commanded_speed`, `fell`, `skip_s` |
| signals | step infos: `infos["humanlike"][signal]`, the `samples_per_step` samples recorded since the previous step, shape `[k, ...]` |

The entry Minari stores at reset is not used, so an episode of n steps gives n × k samples. With
`k > 1` a control-rate environment can report physics-rate signals (for example 4 samples of 120 Hz
ground reaction forces per 30 Hz step); `fs` is then k / control period.

### Recording rollouts

```python
from humanlike.adapters.minari_io import collector, finish

class MyEnv(gym.Env):                      # or a wrapper around an existing environment
    def step(self, action):
        ...                                 # k physics substeps, recording the profile signals
        info["humanlike"] = {"pelvis_pos": pelvis[k_samples], "left_foot_pos": ..., "right_foot_pos": ...,
                             "left_grf": ..., "right_grf": ...}      # each [k, 3]
        return obs, reward, terminated, truncated, info
    # reset() returns the same keys and shapes in its info (the samples are not used)

env = collector(MyEnv())                    # minari.DataCollector with record_infos=True
...                                         # roll out the policy
finish(env, "mylab/mypolicy-v0", fs=120.0, samples_per_step=4, mass_kg=70.0, algorithm_name="...",
       episodes=[{"group": "speed_1.1", "commanded_speed": 1.1}, ...])   # adds the profile, checks the data
```

`finish` reads the dataset back and stops with the reason if a signal is missing; a dataset recorded
without `record_infos=True` is reported with how to fix it. For an existing dataset,
`humanlike.adapters.minari_io.annotate(path, fs=..., samples_per_step=..., mass_kg=...)` adds the
metadata (no minari package needed).

```bash
humanlike validate mylab/mypolicy-v0        # a registered id or a dataset directory
humanlike evaluate mylab/mypolicy-v0 -o results/
humanlike convert c3d trial.c3d mylab/s01-v0 --name S01 --mass 70   # motion capture to Minari (ADAPTERS.md)
```

Reading and writing HDF5 datasets need only h5py (also in the browser); recording with DataCollector and
writing Arrow need `pip install "humanlike[minari]"`. Datasets written by `humanlike convert`, by
`humanlike.adapters.minari_io.write` or by the web app's "Download the data as a Minari dataset" are for
evaluation: they hold the core positions as observations and a zero action placeholder (marked
`"evaluation_only": true` in the profile metadata), the profile signals are in the infos. They are
written in the Minari 0.5 layout, compressed (gzip), and open with the minari package.
