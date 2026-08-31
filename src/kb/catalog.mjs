const KNOWLEDGE_IDS = {
  '凹凸性与拐点': 'kp.calc.application.concavity-inflection',
  '边缘分布与独立性': 'kp.prob.multi.marginal-independence',
  '变限积分': 'kp.calc.integral.variable-limit',
  '常见概率分布': 'kp.prob.rv.common-distributions',
  '常微分方程': 'kp.calc.ode',
  '大数定律与中心极限定理': 'kp.prob.limit-laws',
  '单调性与极值': 'kp.calc.application.monotonicity-extrema',
  '导数': 'kp.calc.diff.derivative',
  '定积分': 'kp.calc.integral.definite',
  '多维随机变量与联合分布': 'kp.prob.multi.joint-distribution',
  '多元函数微分': 'kp.calc.multi.differential',
  '二重积分': 'kp.calc.multi.double-integral',
  '反常积分': 'kp.calc.integral.improper',
  '方差与协方差': 'kp.prob.moment.variance-covariance',
  '高阶导数': 'kp.calc.diff.higher-order',
  '函数': 'kp.calc.foundation.function',
  '函数极限': 'kp.calc.limit.function',
  '离散型随机变量': 'kp.prob.rv.discrete',
  '连续型随机变量与概率密度': 'kp.prob.rv.continuous-density',
  '连续性': 'kp.calc.limit.continuity',
  '偏导数与全微分': 'kp.calc.multi.partial-total',
  '曲面积分': 'kp.calc.multi.surface-integral',
  '曲线积分': 'kp.calc.multi.line-integral',
  '事件独立性': 'kp.prob.event.independence',
  '数列极限': 'kp.calc.limit.sequence',
  '数学期望': 'kp.prob.moment.expectation',
  '随机变量函数的分布': 'kp.prob.rv.function-distribution',
  '随机变量与分布函数': 'kp.prob.rv.cdf',
  '随机事件与概率': 'kp.prob.event.basic',
  '泰勒公式': 'kp.calc.approx.taylor',
  '条件概率与全概率': 'kp.prob.conditional-total',
  '统计推断': 'kp.stat.inference',
  '微分': 'kp.calc.diff.differential',
  '无穷级数': 'kp.calc.series',
  '隐函数与参数方程求导': 'kp.calc.diff.implicit-parametric',
  '原函数与不定积分': 'kp.calc.integral.antiderivative',
  '中值定理': 'kp.calc.theorem.mean-value',
  '总体、样本与统计量': 'kp.stat.sample-statistic',
};

const METHOD_IDS = {
  '单调有界准则': 'method.calc.limit.monotone-bounded',
  '导数定义法': 'method.calc.diff.definition',
  '定积分应用建模': 'method.calc.integral.modeling',
  '多元积分区域分解与转化': 'method.calc.multi.region-transform',
  '分离变量法': 'method.calc.ode.separation',
  '复合隐式参数求导': 'method.calc.diff.implicit-parametric',
  '换元与分部积分': 'method.calc.integral.substitution-parts',
  '积分等式与不等式证明': 'method.calc.integral.identity-inequality',
  '级数收敛与幂级数处理': 'method.calc.series.convergence-power',
  '极限等价替换与洛必达': 'method.calc.limit.equivalent-lhopital',
  '极限定理与统计推断流程': 'method.stat.limit-inference-workflow',
  '联合分布边缘化与数字特征': 'method.prob.joint-marginal-moments',
  '全概率与贝叶斯分解': 'method.prob.total-bayes',
  '随机变量函数分布求法': 'method.prob.function-distribution',
  '泰勒展开': 'method.calc.taylor-expansion',
  '中值定理辅助函数构造': 'method.calc.mean-value.auxiliary-function',
};

export function catalogId(type, title) {
  if (type === 'knowledge_candidate') return KNOWLEDGE_IDS[title] || null;
  if (type === 'method_candidate') return METHOD_IDS[title] || null;
  return null;
}

export function expectedCatalog() {
  return {
    knowledge: { ...KNOWLEDGE_IDS },
    methods: { ...METHOD_IDS },
  };
}

export { KNOWLEDGE_IDS, METHOD_IDS };
