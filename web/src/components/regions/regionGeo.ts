// Azure public region coordinates (lat, lon).
// Source: Microsoft Learn / Azure region geography. Curated to the
// regions the dashboard's `DEFAULT_REGIONS` list scans.
// Used only for the world-map view — no business logic depends on
// these constants, so a missing region degrades gracefully to a card.

export interface RegionGeo {
  region: string;
  label: string;
  lat: number;
  lon: number;
}

export const REGION_GEO: Record<string, RegionGeo> = {
  koreacentral: { region: "koreacentral", label: "Korea Central (Seoul)", lat: 37.5665, lon: 126.978 },
  koreasouth: { region: "koreasouth", label: "Korea South (Busan)", lat: 35.1796, lon: 129.0756 },
  japaneast: { region: "japaneast", label: "Japan East (Tokyo)", lat: 35.6895, lon: 139.6917 },
  japanwest: { region: "japanwest", label: "Japan West (Osaka)", lat: 34.6937, lon: 135.5023 },
  southeastasia: { region: "southeastasia", label: "Southeast Asia (Singapore)", lat: 1.3521, lon: 103.8198 },
  eastasia: { region: "eastasia", label: "East Asia (Hong Kong)", lat: 22.3193, lon: 114.1694 },
  australiaeast: { region: "australiaeast", label: "Australia East (Sydney)", lat: -33.8688, lon: 151.2093 },
  australiasoutheast: { region: "australiasoutheast", label: "Australia Southeast (Melbourne)", lat: -37.8136, lon: 144.9631 },
  centralindia: { region: "centralindia", label: "Central India (Pune)", lat: 18.5204, lon: 73.8567 },
  southindia: { region: "southindia", label: "South India (Chennai)", lat: 13.0827, lon: 80.2707 },
  westindia: { region: "westindia", label: "West India (Mumbai)", lat: 19.076, lon: 72.8777 },
  eastus: { region: "eastus", label: "East US (Virginia)", lat: 37.4316, lon: -78.6569 },
  eastus2: { region: "eastus2", label: "East US 2 (Virginia)", lat: 36.6681, lon: -78.3889 },
  westus: { region: "westus", label: "West US (California)", lat: 36.7783, lon: -119.4179 },
  westus2: { region: "westus2", label: "West US 2 (Washington)", lat: 47.7511, lon: -120.7401 },
  westus3: { region: "westus3", label: "West US 3 (Arizona)", lat: 33.4484, lon: -112.074 },
  centralus: { region: "centralus", label: "Central US (Iowa)", lat: 41.878, lon: -93.0977 },
  northeurope: { region: "northeurope", label: "North Europe (Dublin)", lat: 53.3498, lon: -6.2603 },
  westeurope: { region: "westeurope", label: "West Europe (Amsterdam)", lat: 52.3676, lon: 4.9041 },
  uksouth: { region: "uksouth", label: "UK South (London)", lat: 51.5074, lon: -0.1278 },
  ukwest: { region: "ukwest", label: "UK West (Cardiff)", lat: 51.4816, lon: -3.1791 },
  francecentral: { region: "francecentral", label: "France Central (Paris)", lat: 48.8566, lon: 2.3522 },
  germanywestcentral: { region: "germanywestcentral", label: "Germany West Central (Frankfurt)", lat: 50.1109, lon: 8.6821 },
  swedencentral: { region: "swedencentral", label: "Sweden Central (Gävle)", lat: 60.6749, lon: 17.1413 },
  norwayeast: { region: "norwayeast", label: "Norway East (Oslo)", lat: 59.9139, lon: 10.7522 },
  switzerlandnorth: { region: "switzerlandnorth", label: "Switzerland North (Zürich)", lat: 47.3769, lon: 8.5417 },
  brazilsouth: { region: "brazilsouth", label: "Brazil South (São Paulo)", lat: -23.5505, lon: -46.6333 },
  canadacentral: { region: "canadacentral", label: "Canada Central (Toronto)", lat: 43.6532, lon: -79.3832 },
  canadaeast: { region: "canadaeast", label: "Canada East (Quebec)", lat: 46.8139, lon: -71.208 },
  southafricanorth: { region: "southafricanorth", label: "South Africa North (Johannesburg)", lat: -26.2041, lon: 28.0473 },
  uaenorth: { region: "uaenorth", label: "UAE North (Dubai)", lat: 25.2048, lon: 55.2708 },
};

export function geoFor(region: string | null | undefined): RegionGeo | undefined {
  if (!region) return undefined;
  return REGION_GEO[region];
}
