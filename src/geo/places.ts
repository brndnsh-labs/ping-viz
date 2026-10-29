// Places the story visits. The Act I route is illustrative: a house in Asheville, NC, an ISP that
// hauls traffic to Atlanta, and Google's edge there. Coordinates are city centres, not facilities.

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

export const P = {
  home: { name: "home", lat: 35.5951, lon: -82.5515 },
  ispHub: { name: "ISP hub", lat: 35.6, lon: -82.45 },
  greenville: { name: "Greenville", lat: 34.8526, lon: -82.394 },
  charlotte: { name: "Charlotte", lat: 35.2271, lon: -80.8431 },
  atlanta: { name: "Atlanta", lat: 33.749, lon: -84.388 },
  googleAtl: { name: "Google (Atlanta)", lat: 33.758, lon: -84.395 },
  ashburn: { name: "Ashburn", lat: 39.0438, lon: -77.4874 },
  chicago: { name: "Chicago", lat: 41.8781, lon: -87.6298 },
  dallas: { name: "Dallas", lat: 32.7767, lon: -96.797 },
  newCarlisle: { name: "New Carlisle, IN", lat: 41.7034, lon: -86.5092 },
} satisfies Record<string, Place>;

/**
 * Metros weighted roughly by how much internet infrastructure they host. Used to scatter the ~2,000
 * DNS root server instances and the users in the finale. Weights are coarse on purpose: this is a
 * picture of "everywhere, denser where the people and networks are", not a census.
 */
export const METROS: readonly [string, number, number, number][] = [
  ["New York", 40.71, -74.0, 9],
  ["Ashburn", 39.04, -77.49, 9],
  ["Chicago", 41.88, -87.63, 7],
  ["Atlanta", 33.75, -84.39, 6],
  ["Dallas", 32.78, -96.8, 6],
  ["Miami", 25.76, -80.19, 5],
  ["Los Angeles", 34.05, -118.24, 8],
  ["San Jose", 37.34, -121.89, 8],
  ["Seattle", 47.61, -122.33, 6],
  ["Denver", 39.74, -104.99, 4],
  ["Phoenix", 33.45, -112.07, 3],
  ["Toronto", 43.65, -79.38, 5],
  ["Montreal", 45.5, -73.57, 3],
  ["Vancouver", 49.28, -123.12, 3],
  ["Mexico City", 19.43, -99.13, 5],
  ["Bogotá", 4.71, -74.07, 3],
  ["Lima", -12.05, -77.04, 2],
  ["Santiago", -33.45, -70.67, 3],
  ["Buenos Aires", -34.6, -58.38, 4],
  ["São Paulo", -23.55, -46.63, 7],
  ["Rio de Janeiro", -22.91, -43.17, 4],
  ["London", 51.51, -0.13, 10],
  ["Amsterdam", 52.37, 4.9, 9],
  ["Frankfurt", 50.11, 8.68, 10],
  ["Paris", 48.86, 2.35, 8],
  ["Madrid", 40.42, -3.7, 5],
  ["Milan", 45.46, 9.19, 5],
  ["Stockholm", 59.33, 18.07, 5],
  ["Warsaw", 52.23, 21.01, 4],
  ["Vienna", 48.21, 16.37, 4],
  ["Zurich", 47.38, 8.54, 4],
  ["Dublin", 53.35, -6.26, 4],
  ["Moscow", 55.76, 37.62, 6],
  ["Istanbul", 41.01, 28.98, 4],
  ["Tel Aviv", 32.09, 34.78, 3],
  ["Dubai", 25.2, 55.27, 4],
  ["Cairo", 30.04, 31.24, 3],
  ["Lagos", 6.52, 3.38, 3],
  ["Nairobi", -1.29, 36.82, 3],
  ["Johannesburg", -26.2, 28.05, 4],
  ["Cape Town", -33.92, 18.42, 2],
  ["Mumbai", 19.08, 72.88, 6],
  ["Delhi", 28.61, 77.21, 5],
  ["Bangalore", 12.97, 77.59, 4],
  ["Chennai", 13.08, 80.27, 3],
  ["Singapore", 1.35, 103.82, 8],
  ["Jakarta", -6.21, 106.85, 4],
  ["Bangkok", 13.76, 100.5, 4],
  ["Hong Kong", 22.32, 114.17, 7],
  ["Taipei", 25.03, 121.57, 4],
  ["Shanghai", 31.23, 121.47, 5],
  ["Beijing", 39.9, 116.41, 5],
  ["Seoul", 37.57, 126.98, 6],
  ["Tokyo", 35.68, 139.65, 9],
  ["Osaka", 34.69, 135.5, 4],
  ["Manila", 14.6, 120.98, 3],
  ["Sydney", -33.87, 151.21, 6],
  ["Melbourne", -37.81, 144.96, 4],
  ["Perth", -31.95, 115.86, 2],
  ["Auckland", -36.85, 174.76, 3],
  ["Honolulu", 21.31, -157.86, 2],
  ["Anchorage", 61.22, -149.9, 1],
  ["Reykjavík", 64.15, -21.94, 1],
];
