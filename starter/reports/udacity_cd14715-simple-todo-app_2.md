# 🔍 Code Review Report

## Summary

| Metric | Value |
|--------|-------|
| **Overall Score** | 35/100 |
| **Files Reviewed** | 1 |
| **Critical Issues** | 3 |
| **High Priority Tests** | 7 |
| **Refactoring Opportunities** | 3 |

## 🎯 Top Recommendations

1. 🚨 **Critical Issues**: Review and address 3 critical issue(s).
   - Files: src/todo.ts

2. ⚠️ **Test Coverage**: Add tests for 7 high-priority untested path(s).
   - Files: src/todo.ts

3. 📝 **Refactoring**: Evaluate 3 high-impact refactoring suggestion(s).
   - Files: src/todo.ts

## 📁 File Details

### 📄 `src/todo.ts`

**Quality Score:** 35/100 | **Coverage:** ~0%

#### Issues (3)
  - Line 119: `critical` SQL injection vulnerability in searchTodos function. User-supplied keyword is directly interpolated into SQL query using template literal without parameterization or escaping.
  - Line 128: `critical` SQL injection vulnerability in searchTodosByStatus function. User-supplied completed parameter is directly concatenated into SQL query without type validation or parameterization.
  - Line 137: `critical` SQL injection vulnerability in getTodosByUser function. User-supplied userId is directly interpolated into SQL query using template literal without parameterization.


#### Test Gaps (7)
  - `searchTodos(keyword: string)` (critical priority)
  - `searchTodosByStatus(completed: string)` (critical priority)

  *...and 5 more*

#### Refactoring Opportunities (3)
  - **pattern-improvement**: SQL injection vulnerability via unparameterized template literal with user-supplied keyword
  - **pattern-improvement**: SQL injection vulnerability via string concatenation with unvalidated completed parameter

  *...and 1 more*

---

*Generated at 2026-10-25T12:34:52.772Z • Duration: 18303ms*
