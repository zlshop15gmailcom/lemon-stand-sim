MarketSim Master Build Prompt
Project Name: Lemon Stand Sim

Type: Full-stack web application, paper trading simulator with a living fake market

Stack: React (frontend), Supabase (backend/database), GitHub Pages (hosting), scheduled background jobs for market engine

What This Is
Build a hyper-realistic fake stock market simulator that runs continuously in the background, even when the user is offline. Every company, ticker, financial statement, and news headline is procedurally generated and entirely fictional. The platform mirrors every tool and account type a real U.S. broker-dealer offers. The user starts with a cash balance only and unlocks account types progressively. Time is user-controlled: the user can pause the market, compress it, or fast-forward it. The platform is both a fully functional trading environment and an embedded learning system.

Market Simulation Engine
The engine is the heart of the application. It must run on a backend schedule (e.g., Supabase Edge Functions on a cron job) and update price data continuously, even when no user is logged in.
Price behavior must model:

Geometric Brownian Motion as the base price movement model
Volatility clustering (high-volatility periods cluster together, as in real markets)
Mean reversion for stable, large-cap fake companies
Momentum and trend-following behavior for growth and speculative names
Sector correlations (e.g., fake energy companies move together; fake tech companies move together)
Market-wide beta (all assets respond to the broader fake market index)

Macro environment must include:

A fake Federal Reserve that meets on a schedule and sets a fake federal funds rate
Fake inflation data released monthly (CPI, PCE equivalents)
Fake GDP growth reported quarterly
Fake unemployment figures released on a schedule
A fake yield curve that responds to Fed decisions
Recession and expansion cycles that play out over simulated months or years
Sector rotation behavior tied to the macro cycle (e.g., defensives outperform in downturns)

Company-level events must include:

Quarterly earnings reports with beats, misses, and guidance updates
Fake analyst upgrades and downgrades with price targets
Dividend declarations, splits, and buyback announcements
Mergers, acquisitions, and spin-off events
IPOs that enter the market on a schedule
Fake SEC filings (10-K, 10-Q, 8-K equivalents) with generated financial data
Corporate scandals and restatements that crater prices

Fake news feed must:

Generate headlines tied to real events happening in the simulation (e.g., a Fed rate hike triggers headlines across rate-sensitive sectors)
Include market-moving and noise headlines (not every headline moves the market)
Tag each headline by asset class, sector, and affected tickers
Be browsable and searchable by the user


Asset Classes
The platform must support every instrument a U.S. registered broker-dealer offers. These include:
Equities

Common stock across all fake market sectors (technology, healthcare, energy, financials, consumer discretionary, consumer staples, industrials, utilities, real estate, materials, communication services)
Preferred stock
ADRs (fake foreign company equivalents listed on the fake U.S. exchange)

Fixed Income

U.S. Treasury equivalents (T-bills, T-notes, T-bonds) with a live fake yield curve
Corporate bonds (investment grade and high yield) tied to fake companies
Municipal bond equivalents
Agency bond equivalents
Bond pricing, duration, convexity, and yield-to-maturity calculations must all be live and accurate

Funds

ETFs tracking fake indexes, sectors, commodities, and bond categories
Mutual funds with NAV calculated at end of simulated day
Money market funds

Derivatives

Options on individual fake stocks and fake ETFs
A full options chain with strike prices, expiration dates, and live Greeks (delta, gamma, theta, vega, rho)
Options pricing via Black-Scholes with implied volatility surface
Futures contracts on fake commodities and fake indexes
Options on futures

Alternative Assets

Fake cryptocurrencies with their own volatility regime (higher vol, 24/7 trading)
Commodities (fake oil, gold, silver, agricultural equivalents) with their own supply/demand drivers
Forex pairs between fictional currencies tied to fake countries with fake economic data
REITs as a distinct equity subclass

Margin and Leverage

Margin accounts with Reg T and portfolio margin equivalents
Margin calls triggered at appropriate thresholds
Short selling with borrow rates and hard-to-borrow flags


Brokerage Account Types
The user starts with a cash-only balance. Each account type is unlocked progressively as the user engages with the platform. Every account type must behave according to its real-world rules:

Individual Taxable Brokerage Account (first unlocked)
Traditional IRA (contribution limits, tax-deferred growth simulation)
Roth IRA (income limit simulation, tax-free growth simulation)
SEP-IRA
401(k) equivalent (employer match simulation optional)
Margin Account (requires acknowledgment of risk)
Options Account (tiered approval levels: covered calls only → spreads → naked options)
Futures Account
Crypto Account
Joint Account
Custodial Account (UTMA/UGMA equivalent)
Trust Account
Business/Corporate Account
Health Savings Account equivalent
529 equivalent

Each account must track its own balance, positions, cost basis, and simulated tax treatment separately.

Order Types
Every order type a real broker-dealer offers must be supported:

Market order
Limit order
Stop order
Stop-limit order
Trailing stop (fixed dollar and percentage)
Market-on-open and market-on-close
Limit-on-open and limit-on-close
Good-till-canceled (GTC)
Day order
Fill-or-kill (FOK)
Immediate-or-cancel (IOC)
All-or-none (AON)
One-cancels-other (OCO)
Bracket order
Conditional orders


Trading Tools and Platform Features
Charting

Candlestick, OHLC, line, and area charts
Adjustable timeframes (1 minute through all-time)
Full technical indicator library: moving averages (SMA, EMA, WMA), Bollinger Bands, RSI, MACD, Stochastic Oscillator, ATR, OBV, VWAP, Ichimoku Cloud, Fibonacci retracement, pivot points, and at minimum 30 additional indicators
Drawing tools: trendlines, channels, horizontal levels, shapes, text annotations
Multi-chart layouts (side-by-side comparisons)
Chart templates that can be saved and reloaded

Screener

Scan the entire fake market by any combination of: price, volume, market cap, sector, P/E, P/B, EPS growth, dividend yield, 52-week range, RSI, moving average crossovers, and any other fundamental or technical metric available in the system
Save and name custom scans
Run scans on stocks, ETFs, bonds, options, crypto, commodities, and forex separately

Options Tools

Full options chain display with live Greeks
P&L diagram builder for any options strategy (single leg through multi-leg)
Strategy builder that suggests and explains common options strategies based on user's market outlook
Implied volatility rank and percentile
Volatility skew visualization
Roll tool for managing expiring positions

Fixed Income Tools

Bond screener by credit rating, duration, yield, maturity
Yield curve visualizer
Duration and convexity calculator
Bond ladder builder

Fundamental Analysis

Full fake financial statements for every fake company: income statement, balance sheet, cash flow statement
Key ratios calculated live: P/E, P/B, P/S, EV/EBITDA, ROE, ROA, debt-to-equity, current ratio, quick ratio, gross margin, net margin, FCF yield
Earnings history with surprise data
Analyst consensus (fake buy/hold/sell ratings with price targets)
Comparable company analysis tool (side-by-side financials)
DCF model builder with user-adjustable assumptions

Portfolio Tools

Real-time portfolio dashboard with total value, cash, invested amount, day P&L, total P&L
Asset allocation breakdown by asset class, sector, geography, and account
Risk metrics: portfolio beta, Sharpe ratio, Sortino ratio, max drawdown, correlation matrix
Performance attribution (which positions drove gains and losses)
Dividend tracker and income calendar
Tax lot management and harvesting tool
Rebalancing tool with target allocation input

Research

Fake company profile pages with business description, sector, key executives, financials, news, and filings
Fake analyst research reports (generated summaries)
Fake economic calendar showing upcoming macro events
Fake earnings calendar

Alerts

Price alerts (above/below threshold)
Percentage move alerts
Volume spike alerts
News alerts by ticker or sector
Economic event alerts
Options expiration reminders
Margin call warnings


Time Controls
The user controls the speed of simulated time from a persistent control bar:

Pause: market freezes entirely, no prices update
1x: one simulated market minute passes per real minute (real-time feel)
10x: one simulated trading day passes per roughly 40 real minutes
100x: one simulated trading week passes per real hour
1000x: one simulated month passes per real hour (for testing long-term strategies)
Custom: user enters a multiplier manually

The current simulated date and time are always displayed prominently. The simulated calendar tracks market hours, weekends, holidays, and scheduled macro events on their correct cadence relative to the current sim date.

Learning System
The learning system is deeply integrated with the platform, not bolted on as a separate tab.
Contextual tooltips everywhere: Every piece of data, every metric, every order type, every field has an icon the user can tap to get a plain-English explanation of what it means and why it matters.
Account unlock tutorials: When the user unlocks a new account type (Roth IRA, margin account, options account, etc.), a guided walkthrough explains the rules, restrictions, tax treatment, and appropriate use cases for that account before the user can deposit funds into it.
Feature unlock tutorials: When the user accesses a new tool for the first time (options chain, bond screener, futures, forex, etc.), a brief guided tutorial walks through what the tool does, how to read it, and a simple example trade.
Learning Center (dedicated section):

Organized by topic: Equities, Fixed Income, Options, Macro Economics, Technical Analysis, Fundamental Analysis, Portfolio Management, Tax Strategy, Risk Management
Each topic contains short written lessons, visual explainers, and a "try it now" button that opens the relevant tool in the simulator with a guided example
A glossary of every term used anywhere in the platform
A strategy library that explains common investing and trading strategies (value investing, dividend growth, covered calls, bond laddering, pairs trading, etc.) and links directly to the tools needed to execute them in the simulator

Trade journal: After every closed trade, the platform prompts the user to log what their thesis was, what happened, and what they learned. The journal is searchable and filterable. Over time it builds a record of the user's decision-making patterns.
Performance coaching: The platform analyzes the user's trade history and surfaces observations, not grades. For example: "You tend to sell winning positions faster than losing ones" or "Your options trades expire worthless more than 60% of the time." No judgment, just data.

Technical Requirements

Frontend: React with a professional brokerage-quality UI (dark mode default, light mode available)
Backend: Supabase for database, authentication, and edge functions
Market engine: Supabase Edge Functions on a cron schedule, running independently of any user session
Hosting: GitHub Pages or Supabase-hosted frontend
All fake company names, tickers, financials, and news must be procedurally generated and stored in the database, not hardcoded
The system must support at least 500 fake equities, 50 fake ETFs, 20 fake mutual funds, 10 fake crypto assets, 20 fake forex pairs, and 15 fake commodity contracts at launch
Price history must be stored for every asset from the simulated start date forward
The platform must be fully functional on desktop browsers; mobile-responsive is a stretch goal


Out of Scope for Initial Build

Real money, real brokerage integration, or real market data
Multiplayer or social features
Mobile native app
AI-generated personalized lessons (static lessons only at launch)
