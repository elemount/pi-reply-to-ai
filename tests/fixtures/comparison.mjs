import { git, gitComparison, diffOptions } from "../../git.ts";

/** Test-only rendering to keep ancestry assertions independent of the Neovim UI. */
export async function gitReview(cwd, target) {
	const comparison = await gitComparison(cwd, target);
	if (!comparison) return;
	const patch = await git(comparison.root, ["diff", ...diffOptions, comparison.left, ...(comparison.right ? [comparison.right] : []), "--"]);
	return comparison.provenance.map(line => "# " + line).join("\n") + "\n\n" + patch;
}
