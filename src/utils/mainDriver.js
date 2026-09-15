import { isStoredImageUrl } from "./localFileStore.js";


export function validateMainDriverCheckInDetails(mainDriver) {
  if (!mainDriver || typeof mainDriver !== "object") {
    return "Main driver details are required";
  }

  const required = [
    ["fullLegalName", "full legal name"],
    ["dateOfBirth", "date of birth"],
    ["phoneNumber", "phone number"],
    ["emailAddress", "email address"],
    ["homeAddressLine1", "home address (line 1)"],
    ["licenseNumber", "driver's license number"],
    ["issuingProvince", "issuing province"],
    ["licenseExpiryDate", "license expiry date"],
  ];

  for (const [field, label] of required) {
    if (!mainDriver[field]?.trim()) {
      return `Main driver: ${label} is required`;
    }
  }

  if (!isStoredImageUrl(mainDriver.licenseImageUrl)) {
    return "Main driver: license image is required";
  }

  return null;
}

export function normalizeMainDriverCheckInDetails(mainDriver) {
  return {
    fullLegalName: mainDriver.fullLegalName.trim(),
    dateOfBirth: mainDriver.dateOfBirth.trim(),
    phoneNumber: mainDriver.phoneNumber.trim(),
    emailAddress: mainDriver.emailAddress.trim(),
    homeAddressLine1: mainDriver.homeAddressLine1.trim(),
    homeAddressLine2: mainDriver.homeAddressLine2?.trim() || undefined,
    homeAddressLine3: mainDriver.homeAddressLine3?.trim() || undefined,
    licenseNumber: mainDriver.licenseNumber.trim(),
    issuingProvince: mainDriver.issuingProvince.trim(),
    licenseExpiryDate: mainDriver.licenseExpiryDate.trim(),
    policyNo: mainDriver.policyNo?.trim() || "",
    licenseImageUrl: mainDriver.licenseImageUrl.trim(),
  };
}

export function buildMainDriverCheckInDefaults(customer) {
  return {
    fullLegalName: customer?.name?.trim() ?? "",
    dateOfBirth: "",
    phoneNumber: customer?.phone?.trim() ?? "",
    emailAddress: customer?.email?.trim() ?? "",
    homeAddressLine1: "",
    homeAddressLine2: "",
    homeAddressLine3: "",
    licenseNumber: "",
    issuingProvince: "",
    licenseExpiryDate: "",
    policyNo: "",
  };
}
