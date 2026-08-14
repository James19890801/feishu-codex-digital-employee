function failureSummary(error) {
  return String(error?.message || error || '未知错误').replace(/\s+/gu, ' ').trim().slice(0, 500);
}

function withEvidenceRisk(spec, message) {
  return {
    ...spec,
    codeEvidence: [],
    risks: [...new Set([...(spec.risks || []), message])],
  };
}

export async function prepareRequirementWithRepositoryEvidence({
  request,
  route,
  clarification = '',
  existingBody = '',
} = {}, {
  planRequirement,
  searchRepository,
  viewRepositoryFile,
  extractPaths,
} = {}) {
  if (typeof planRequirement !== 'function') throw new Error('planRequirement is required');
  const initial = await planRequirement({
    request, route, clarification, existingBody, repositoryEvidence: '',
  });
  if (!route?.inspectRepository) return { ...initial, codeEvidence: [] };

  const searchTerm = initial.codeSearchTerms?.[0] || initial.title;
  try {
    const repository = await searchRepository({
      repo: route.repo,
      keyword: searchTerm,
      branch: route.branch,
    });
    const searchPaths = extractPaths(repository.search);
    const paths = searchPaths.length ? searchPaths : extractPaths(repository.tree);
    if (!paths.length) {
      return withEvidenceRisk(
        initial,
        `代码检索未定位到与“${searchTerm}”相关的可读文件；需求继续建单，代码影响范围待补充。`,
      );
    }
    const inspected = [];
    for (const path of paths.slice(0, 3)) {
      const content = await viewRepositoryFile({
        repo: route.repo,
        path,
        branch: route.branch,
        startLine: 1,
        endLine: 240,
      });
      inspected.push({ path, content });
    }
    return planRequirement({
      request,
      route,
      clarification,
      existingBody,
      repositoryEvidence: JSON.stringify({
        repository: route.repo,
        branch: route.branch || 'default',
        files: inspected,
      }).slice(0, 60_000),
    });
  } catch (error) {
    return withEvidenceRisk(
      initial,
      `代码检索未完成：${failureSummary(error)}；需求继续建单，代码证据待重试补充。`,
    );
  }
}
