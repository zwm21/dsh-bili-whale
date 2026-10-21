// 分享的统一校验（2026-10-21 从上游 v0.4.0 搬）
//
// 为什么需要它：以前「标尺」那套校验（share.enabled / --reason / --score / --rank）
// 只写在 comment.mjs 里 ✗ → dm.mjs 的 --share 完全绕过，只过了额度闸 gate()
//   → 后果：在设置里关掉「分享评论」总开关，评论区发不出去，
//     但走私信照样能发 ✗（用户根本不知道开关只挡住了一半）
//   → 而且私信分享连"值不值"的评分都不用过，质量标准被绕开 ✗
//
// 现在评论与私信共用这一个函数 ✓ 两边行为一致。
export function validateShare(cfg, { reason, score, rank = 1 }) {
  if (cfg.share?.enabled === false) throw new Error('分享已关闭（share.enabled=false）')
  if (typeof reason !== 'string' || reason.trim().length < 8) throw new Error('分享需要 --reason（至少 8 字）')
  const n = Number(score), threshold = Number(cfg.share?.minScore ?? 13)
  if (score === undefined || score === '' || typeof score === 'boolean' || !Number.isFinite(n) || n < 0 || n > 20)
    throw new Error('分享需要 --score（0–20）')
  if (!Number.isFinite(threshold) || n < threshold) throw new Error(`评分 ${n} 未达到阈值 ${threshold}`)
  if (typeof rank === 'boolean' || Number(rank) !== 1) throw new Error('分享只允许 --rank 1')
  return { score: n, reason: reason.trim(), rank: 1 }
}
