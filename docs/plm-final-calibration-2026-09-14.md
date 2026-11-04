# PLM final calibration — 2026-09-14

## Evidence

The current-policy cohort (p3h 1.5..5%, n=45) produced 9 profit, 9 stop,
23 protected, and 4 expired outcomes: average +2.50%, net +112.33.

Applying the evidence-backed p24h cap (`p24h <= 15%`) leaves n=32 with 7
profit, 5 stop, 16 protected, and 4 expired outcomes: average +4.11%, net
+131.66. The removed `p24h > 15%` cohort is n=13 with 2 profit, 4 stop, 7
protected, and 0 expired outcomes: average -1.49%, net -19.33.

Validation evidence is directionally consistent: the Sep 1 pre-cap removal
cohort (n=10) was net -18.61, and the latest post-cap FLOCK observation
(p24h 15.59%) stopped. The train removed cohort is only n=2 and net +12.03,
so it is a small instability signal rather than a reason to overturn the cap.

## Policy

PLM now admits `p24h` from 5% through 15% inclusive and retains `p3h` at
1.5..5%. No changes were made to p3h, SNF, CVD, OI, taker, volume, or exit
policy. The p24h upper-bound rejection is retained in final-gate trajectory
admission; low-p24h rejects are not full-admitted.
