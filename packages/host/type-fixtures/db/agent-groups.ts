/** CI-only stub — real module exists once installed into a NanoClaw host. */
export function getAgentGroup(
  id: string,
): { id: string; name: string; folder: string } | undefined {
  return { id, name: id, folder: id };
}
