// Only accept admission metadata from the authenticated account service.
// Missing metadata (including an old backend) fails closed.
export function accessPolicy() {
  return { mode: "self-service", canCreateOrganization: false, allows: (organization) => organization?.hubAccessEnabled === true };
}
